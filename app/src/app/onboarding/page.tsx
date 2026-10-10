'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Building2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Logo } from '@/components/brand/logo'
import { createClient } from '@/lib/supabase/client'
import { SIGNUP_CLOSED_MESSAGE } from '@/lib/auth/signup-closed'

const onboardingSchema = z.object({
  name: z.string().min(1, 'Business name is required'),
  email: z.string().email('Invalid email').optional().or(z.literal('')),
})

type OnboardingForm = z.infer<typeof onboardingSchema>

export default function OnboardingPage() {
  const router = useRouter()
  const [isReady, setIsReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<OnboardingForm>({
    resolver: zodResolver(onboardingSchema),
    defaultValues: { name: '', email: '' },
  })

  // This route lives outside the (app) group, so it does its own auth check
  useEffect(() => {
    async function checkAuth() {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()

      if (!user) {
        router.replace('/login?redirect=/onboarding')
        return
      }

      if (user.email) {
        setValue('email', user.email)
      }
      setIsReady(true)
    }

    checkAuth()
  }, [router, setValue])

  async function onSubmit(data: OnboardingForm) {
    setError(null)

    const supabase = createClient()
    const { data: business, error: rpcError } = await supabase.rpc(
      'create_business_with_owner',
      {
        business_name: data.name,
        business_email: data.email || undefined,
      }
    )

    if (rpcError) {
      setError(
        rpcError.message.includes('signup_closed') ? SIGNUP_CLOSED_MESSAGE : rpcError.message,
      )
      return
    }

    if (!business) {
      setError('Something went wrong creating your business. Please try again.')
      return
    }

    // The (app) BusinessProvider mounts fresh on navigation and fetches businesses
    router.push('/dashboard')
    router.refresh()
  }

  if (!isReady) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col">
      {/* Simple header with logo */}
      <header className="border-b border-border/40">
        <div className="mx-auto flex h-16 max-w-7xl items-center px-4 sm:px-6 lg:px-8">
          <Link href="/">
            <Logo />
          </Link>
        </div>
      </header>

      {/* Main content */}
      <main className="flex flex-1 items-center justify-center px-4 py-12 sm:px-6 lg:px-8">
        <div className="w-full max-w-sm">
          <div className="text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
              <Building2 className="h-6 w-6 text-primary" />
            </div>
            <h1 className="mt-4 text-2xl font-bold tracking-tight text-foreground">
              Welcome to Billr
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Set up your business to start invoicing. You can fill in the
              details later in settings.
            </p>
          </div>

          <form onSubmit={handleSubmit(onSubmit)} className="mt-8 space-y-4">
            {error && (
              <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="name">Business name</Label>
              <Input
                id="name"
                type="text"
                placeholder="Acme Design Studio"
                autoFocus
                {...register('name')}
              />
              {errors.name && (
                <p className="text-sm text-destructive">{errors.name.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">
                Business email{' '}
                <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                {...register('email')}
              />
              {errors.email && (
                <p className="text-sm text-destructive">{errors.email.message}</p>
              )}
            </div>

            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create business
            </Button>
          </form>
        </div>
      </main>
    </div>
  )
}
