'use client'

import { Suspense, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { signInAction } from '@/lib/auth/actions'
import { OAuthSignIn } from '@/components/auth/oauth-sign-in'
import { safeAuthRedirect } from '@/lib/auth/redirect'
import { ACCESS_CHECK_FAILED_MESSAGE, SIGNUP_CLOSED_MESSAGE } from '@/lib/auth/signup-closed'

const loginSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
})

type LoginForm = z.infer<typeof loginSchema>

export default function LoginPage() {
  return (
    <Suspense>
      <LoginPageInner />
    </Suspense>
  )
}

function LoginPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const redirect = safeAuthRedirect(searchParams.get('redirect'))
  const [error, setError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
  })

  async function onSubmit(data: LoginForm) {
    setError(null)

    // Goes through a server action rather than calling Supabase from the
    // browser, so the attempt passes a rate limit and abuse lockout we control
    // (src/lib/auth/guard.ts) before it reaches the auth provider.
    const result = await signInAction({
      email: data.email,
      password: data.password,
    })

    if (!result.success) {
      setError(result.error ?? 'Could not sign in. Please try again.')
      return
    }

    router.push(redirect)
    router.refresh()
  }

  return (
    <div className="w-full max-w-sm">
      <div className="text-center">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Welcome back
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Sign in to your account to continue
        </p>
      </div>

      {searchParams.get('error') === 'auth' && (
        <p
          role="alert"
          className="mt-5 rounded-lg bg-destructive/5 p-3 text-sm text-destructive"
        >
          Sign-in was cancelled or the link expired. Please try again.
        </p>
      )}
      {searchParams.get('error') === 'signup_closed' && (
        <p role="alert" className="mt-5 rounded-lg bg-destructive/5 p-3 text-sm text-destructive">
          {SIGNUP_CLOSED_MESSAGE}
        </p>
      )}
      {searchParams.get('error') === 'access_check' && (
        <p role="alert" className="mt-5 rounded-lg bg-destructive/5 p-3 text-sm text-destructive">
          {ACCESS_CHECK_FAILED_MESSAGE}
        </p>
      )}
      <OAuthSignIn next={redirect} />
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {error && (
          <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            autoComplete="email"
            {...register('email')}
          />
          {errors.email && (
            <p className="text-sm text-destructive">{errors.email.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            <Link
              href="/forgot-password"
              className="text-sm text-primary hover:underline"
            >
              Forgot password?
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            placeholder="••••••••"
            autoComplete="current-password"
            {...register('password')}
          />
          {errors.password && (
            <p className="text-sm text-destructive">
              {errors.password.message}
            </p>
          )}
        </div>

        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Sign in
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        Don&apos;t have an account?{' '}
        <Link href="/signup" className="text-primary hover:underline">
          Sign up
        </Link>
      </p>
    </div>
  )
}
