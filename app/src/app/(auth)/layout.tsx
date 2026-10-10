import Link from 'next/link'
import { Logo } from '@/components/brand/logo'

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="auth-shell flex min-h-screen flex-col bg-[#f7f8fa]">
      {/* Simple header with logo */}
      <header className="bg-transparent">
        <div className="mx-auto flex h-16 max-w-7xl items-center px-4 sm:px-6 lg:px-8">
          <Link href="/">
            <Logo />
          </Link>
        </div>
      </header>

      {/* Main content */}
      <main className="flex flex-1 items-center justify-center px-4 py-12 sm:px-6 lg:px-8">
        <div className="w-full max-w-[440px] rounded-2xl border border-zinc-200 bg-white p-7 shadow-[0_12px_40px_-24px_#18181b30] sm:p-10">
          {children}
        </div>
      </main>
    </div>
  )
}
