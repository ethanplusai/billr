import type { Metadata } from 'next'

// Public invoice/estimate documents are keyed on unguessable IDs and must not
// be indexed by search engines.
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
}

export default function PublicLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen bg-muted/30">
      {children}
    </div>
  )
}

