// Local-only acceptance. Creates fictional records and never contacts Stripe/email.
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
const api = process.env.NEXT_PUBLIC_SUPABASE_URL,
  // Defaults to the app origin setup:local wrote, so a BILLR_LOCAL_APP_PORT
  // chosen there is followed here without repeating it.
  app =
    process.env.BILLR_LOCAL_APP_URL ||
    new URL('/api/mcp', process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').href
for (const raw of [api, app]) {
  const u = new URL(raw)
  if (
    !['localhost', '127.0.0.1'].includes(u.hostname) ||
    u.protocol !== 'http:'
  )
    throw Error('Acceptance scripts require local HTTP endpoints')
}
if (new URL(api).port !== (process.env.BILLR_LOCAL_DB_PORT || '56421'))
  throw Error('Use the explicitly selected local Billr database port')
const db = createClient(api, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})
const email = `acceptance-${randomUUID()}@example.test`,
  password = randomBytes(24).toString('hex')
const { data: auth, error: authError } = await db.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
})
if (authError) throw authError
const user = auth.user.id,
  business = randomUUID(),
  clientId = randomUUID()
async function write(table, record) {
  const { error } = await db.from(table).insert(record)
  if (error) throw error
}
await write('businesses', {
  id: business,
  name: 'Fictional acceptance studio',
  default_currency: 'USD',
})
await write('business_members', {
  business_id: business,
  user_id: user,
  role: 'owner',
})
await write('clients', {
  id: clientId,
  business_id: business,
  name: 'Fictional acceptance client',
  currency: 'USD',
})
const human = createClient(api, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
})
const login = await human.auth.signInWithPassword({ email, password })
if (login.error) throw login.error
const { data: policy, error: policyError } = await human
  .from('billing_policies')
  .insert({
    business_id: business,
    client_id: clientId,
    name: 'Approved local pricing',
    currency: 'USD',
    hourly_rate: 100,
    usage_multiplier: 1.5,
    budget: 50,
  })
  .select()
  .single()
if (policyError) throw policyError
const secret = `billr_sk_${randomBytes(24).toString('hex')}`,
  keyId = randomUUID()
await write('api_keys', {
  id: keyId,
  user_id: user,
  business_id: business,
  label: 'Local acceptance',
  key_hash: createHash('sha256').update(secret).digest('hex'),
  key_prefix: secret.slice(0, 12),
  permissions: ['read', 'write'],
})
const client = new Client({ name: 'billr-local-acceptance', version: '1.0' })
const transport = new StreamableHTTPClientTransport(new URL(app), {
  requestInit: { headers: { Authorization: `Bearer ${secret}` } },
})
try {
  await client.connect(transport)
  const listed = await client.listTools()
  assert(!listed.tools.some((t) => t.name === 'send_invoice'))
  async function call(name, args) {
    const result = await client.callTool({ name, arguments: args })
    if (result.isError) throw Error(`${name}: ${result.content[0].text}`)
    return JSON.parse(result.content[0].text)
  }
  const workRequest = randomUUID(),
    workArgs = {
      request_id: workRequest,
      client_id: clientId,
      description: '36 seconds of work',
      hours: 0.01,
      rate: 100,
    }
  const logged = await call('log_time', workArgs),
    replay = await call('log_time', workArgs)
  assert.equal(logged.time_entry.id, replay.time_entry.id)
  assert.equal(logged.time_entry.amount, 1)
  const invoiceArgs = {
    request_id: randomUUID(),
    client_id: clientId,
    time_entry_ids: [logged.time_entry.id],
  }
  const drafted = await call('create_invoice', invoiceArgs),
    draftReplay = await call('create_invoice', invoiceArgs)
  assert.equal(drafted.invoice.id, draftReplay.invoice.id)
  assert.equal(drafted.invoice.total, 1)
  const estimate = await call('create_estimate', {
    request_id: randomUUID(),
    client_id: clientId,
    line_items: [{ description: 'Quoted work', quantity: 1, rate: 10 }],
  })
  assert.equal(estimate.estimate.total, 10)
  const taskArgs = {
    request_id: randomUUID(),
    policy_id: policy.id,
    title: 'Fictional agent task',
  }
  const task = (await call('create_task', taskArgs)).result.task
  assert.equal((await call('create_task', taskArgs)).result.task.id, task.id)
  await call('start_task', { request_id: randomUUID(), task_id: task.id })
  await call('record_task_usage', {
    request_id: randomUUID(),
    task_id: task.id,
    provider: 'Fictional provider',
    provider_request_id: randomUUID(),
    cost: 2,
    currency: 'USD',
    source: 'Local acceptance fixture',
  })
  await call('complete_task', { request_id: randomUUID(), task_id: task.id })
  const preview = await call('get_task_billing_preview', { task_id: task.id })
  assert.equal(preview.usage_amount, 3)
  const { data: approved, error } = await human.rpc('task_operation', {
    p_business_id: business,
    p_request_id: randomUUID(),
    p_action: 'invoice',
    p_input: { task_id: task.id },
  })
  if (error) throw error
  const { data: invoice, error: invoiceError } = await human
    .from('invoices')
    .select('status,total')
    .eq('id', approved.task.invoice_id)
    .single()
  if (invoiceError) throw invoiceError
  assert.equal(invoice.status, 'draft')
  const { data: audit } = await human
    .from('agent_tool_calls')
    .select('status')
    .eq('key_id', keyId)
  assert(audit.length >= 10)
  assert(audit.every((c) => c.status === 'succeeded'))
  if (process.env.BILLR_EXPORT_CONTRACTS === '1') {
    const updated = await db
      .from('api_keys')
      .update({ permissions: ['read', 'write', 'send', 'delete', 'payments'] })
      .eq('id', keyId)
    if (updated.error) throw updated.error
    const contracts = await client.listTools()
    const serialized =
      JSON.stringify(
        contracts.tools.sort((a, b) => a.name.localeCompare(b.name)),
        null,
        2,
      ) + '\n'
    if (serialized.includes(secret) || serialized.includes(email))
      throw Error('Unexpected private data in tool metadata')
    await writeFile(
      new URL(
        '../../packages/agent-kit/src/tool-contracts.json',
        import.meta.url,
      ),
      serialized,
    )
  }
  await db
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', keyId)
  await assert.rejects(() => client.listTools())
  console.log(
    'PASS: scoped SDK connection, revoked key, work/invoice retries, estimate creation, approved task pricing, usage markup, human draft approval and audit records.',
  )
} finally {
  await client.close()
  await db
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', keyId)
  await human.auth.signOut()
}
