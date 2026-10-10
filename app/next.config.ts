import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // The Docker image runs Next.js's standalone server.
  output: process.env.BILLR_CONTAINER_BUILD === 'true' ? 'standalone' : undefined,
  experimental:
    process.env.BILLR_CONTAINER_BUILD === 'true'
      ? { cpus: 1, webpackMemoryOptimizations: true }
      : {},
  // Server actions include passwords and invoice data; never print arguments.
  logging: { serverFunctions: false },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // Public invoice/estimate URLs carry the secret public_id in the
          // path; keep it out of the Referer sent to third parties.
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains',
          },
        ],
      },
    ]
  },
}

export default nextConfig
