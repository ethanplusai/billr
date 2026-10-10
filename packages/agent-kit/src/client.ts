import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

/** Connect with an API key stored in an environment variable. Never ship it to a browser. */
export async function connectBillr(options: {
  apiKey: string
  url: string
  name?: string
}) {
  if (!options.url)
    throw new Error('Provide the MCP URL of your Billr installation')
  if (!options.apiKey) throw new Error('A Billr API key is required')
  const url = new URL(options.url)
  if (
    url.protocol !== 'https:' &&
    !(
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
  )
    throw new Error('Billr connections require HTTPS outside localhost')
  if (url.username || url.password)
    throw new Error('Do not embed credentials in the endpoint URL')
  const client = new Client({
    name: options.name ?? 'billr-agent-kit',
    version: '0.1.0',
  })
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${options.apiKey}` } },
  })
  try {
    await client.connect(transport)
    return client
  } catch (error) {
    await transport.close().catch(() => {})
    throw error
  }
}
