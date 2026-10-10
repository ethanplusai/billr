import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import { Toaster } from "@/components/ui/sonner"
import { appOrigin } from "@/lib/deployment"
import "./globals.css"

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  // Absolute URLs in metadata resolve against this installation's origin.
  metadataBase: new URL(appOrigin()),
  title: {
    default: "Billr - Professional Invoicing",
    template: "%s | Billr",
  },
  description: "Billr is invoicing built for AI agents. Create clients, log work, and send polished invoices from Claude Code, Codex, or any MCP client, while you stay in control.",
  keywords: ["invoicing", "billing", "freelance", "small business", "ai agents", "mcp"],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`}
      >
        {children}
        <Toaster richColors position="top-right" />
      </body>
    </html>
  )
}
