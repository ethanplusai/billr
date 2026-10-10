import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
const compose = readFileSync(new URL('../compose.yaml', import.meta.url), 'utf8')

test('the image build gives Next.js at least 3 GB of heap by default', () => {
  const heap = dockerfile.match(/^ARG BILLR_BUILD_HEAP_MB=(\d+)$/m)
  assert(heap, 'the BILLR_BUILD_HEAP_MB build argument is missing')
  assert(Number(heap[1]) >= 3072, `default build heap is ${heap[1]} MB`)
  assert.match(dockerfile, /--max-old-space-size=\$\{BILLR_BUILD_HEAP_MB\} npm run build/)
})

test('no build step hard-codes a smaller heap', () => {
  assert.doesNotMatch(dockerfile, /--max-old-space-size=\d+ npm run build/)
})

test('the running container knows it is a container', () => {
  assert.match(dockerfile, /^ENV .*\bBILLR_CONTAINER=true\b/m)
})

test('Compose forwards the build heap', () => {
  assert.match(compose, /BILLR_BUILD_HEAP_MB: \$\{BILLR_BUILD_HEAP_MB:-3072\}/)
})

test('Compose lets the container reach the host, on Linux too', () => {
  assert.match(compose, /- 'host\.docker\.internal:host-gateway'/)
})

test('Compose takes SUPABASE_INTERNAL_URL from the shell or the env file', () => {
  assert.match(compose, /SUPABASE_INTERNAL_URL: \$\{SUPABASE_INTERNAL_URL:-\}/)
})
