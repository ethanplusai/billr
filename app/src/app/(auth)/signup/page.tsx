'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { ArrowRight, Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { OAuthSignIn } from '@/components/auth/oauth-sign-in'
import { signUpAction, signupStatusAction } from '@/lib/auth/actions'
import { SIGNUP_CLOSED_MESSAGE } from '@/lib/auth/signup-closed'

const signupSchema = z.object({
  fullName: z.string().min(2, 'Name must be at least 2 characters'),
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
})

type SignupForm = z.infer<typeof signupSchema>

export default function SignupPage() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [emailSent, setEmailSent] = useState(false)
  const [open, setOpen] = useState<boolean | null>(null)

  useEffect(() => {
    signupStatusAction()
      .then((status) => setOpen(status.open))
      .catch(() => setOpen(false))
  }, [])

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignupForm>({
    resolver: zodResolver(signupSchema),
  })

  async function onSubmit(data: SignupForm) {
    setError(null)
    // Server action, not a direct browser call to Supabase, so the attempt
    // passes our rate limit and abuse lockout first (src/lib/auth/guard.ts).
    const result = await signUpAction({
      email: data.email,
      password: data.password,
      fullName: data.fullName,
    })

    if (!result.success) {
      setError(
        result.error ?? 'Could not create your account. Please try again.',
      )
      return
    }

    // Email autoconfirm is on, so signUp returns an active session
    if (result.hasSession) {
      router.push('/onboarding')
      router.refresh()
      return
    }

    // Fallback: confirmation email required
    setEmailSent(true)
  }

  if (open === false) {
    return (
      <div className="w-full max-w-sm text-center">
        <h1 className="text-xl font-semibold">Sign-up is closed</h1>
        <p className="mt-2 text-sm text-muted-foreground">{SIGNUP_CLOSED_MESSAGE}</p>
        <Link href="/login" className="mt-6 inline-block text-sm font-medium underline">
          Sign in instead
        </Link>
      </div>
    )
  }

  if (emailSent) {
    return (
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
          <Check className="h-8 w-8 text-green-600" />
        </div>
        <h1 className="mt-6 text-2xl font-bold tracking-tight text-foreground">
          Check your email
        </h1>
        <p className="mt-3 text-muted-foreground">
          We&apos;ve sent you a confirmation link. Please check your email to
          verify your account.
        </p>
        <Button className="mt-8" variant="outline" asChild>
          <Link href="/login">
            Back to sign in
            <ArrowRight className="ml-2 h-4 w-4" />
          </Link>
        </Button>
      </div>
    )
  }

  return (
    <div className="w-full max-w-sm">
      <div className="text-center">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          Create your account
        </h1>
      </div>

      <OAuthSignIn />

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        {error && (
          <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="fullName">Full name</Label>
          <Input
            id="fullName"
            type="text"
            placeholder="John Doe"
            autoComplete="name"
            {...register('fullName')}
          />
          {errors.fullName && (
            <p className="text-sm text-destructive">
              {errors.fullName.message}
            </p>
          )}
        </div>

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
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            placeholder="Min. 8 characters"
            autoComplete="new-password"
            {...register('password')}
          />
          {errors.password && (
            <p className="text-sm text-destructive">
              {errors.password.message}
            </p>
          )}
        </div>

        <Button
          type="submit"
          className="w-full"
          disabled={isSubmitting}
        >
          {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Create account
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link href="/login" className="text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  )
}
