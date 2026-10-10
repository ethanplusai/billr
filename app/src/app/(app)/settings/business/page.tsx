'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/shared/page-header'
import { SettingsLayout } from '@/components/settings/settings-layout'
import { useBusiness } from '@/lib/hooks/use-business'
import { createClient } from '@/lib/supabase/client'
import { updateBusinessProfileAction } from '@/lib/actions/business'

const businessSchema = z.object({
  name: z.string().min(1, 'Business name is required'),
  legal_name: z.string().optional(),
  email: z.string().email('Invalid email').optional().or(z.literal('')),
  phone: z.string().optional(),
  website: z.string().url('Invalid URL').optional().or(z.literal('')),
  address_line1: z.string().optional(),
  address_line2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postal_code: z.string().optional(),
  country: z.string().optional(),
  tax_id: z.string().optional(),
})

type BusinessForm = z.infer<typeof businessSchema>

const createBusinessSchema = z.object({
  name: z.string().min(1, 'Business name is required'),
  email: z.string().email('Invalid email').optional().or(z.literal('')),
})

type CreateBusinessForm = z.infer<typeof createBusinessSchema>

export default function BusinessSettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <BusinessSettingsPageInner />
    </Suspense>
  )
}

function BusinessSettingsPageInner() {
  const searchParams = useSearchParams()
  const isCreating = searchParams.get('new') === 'true'

  if (isCreating) {
    return <CreateBusinessView />
  }

  return <EditBusinessView />
}

function CreateBusinessView() {
  const router = useRouter()
  const { refreshBusinesses } = useBusiness()
  const [error, setError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CreateBusinessForm>({
    resolver: zodResolver(createBusinessSchema),
    defaultValues: { name: '', email: '' },
  })

  async function onSubmit(data: CreateBusinessForm) {
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
      setError(rpcError.message)
      return
    }

    if (business) {
      // BusinessProvider restores the saved selection from this key on refresh
      localStorage.setItem('billr_current_business', business.id)
    }
    await refreshBusinesses()
    router.replace('/settings/business')
  }

  return (
    <div className="p-6 lg:p-8">
      <PageHeader
        title="New Business"
        description="Create another business to invoice from"
      />

      <div className="mt-6 max-w-lg">
        <Card>
          <CardHeader>
            <CardTitle>Business Information</CardTitle>
            <CardDescription>
              You can fill in the rest of the details after creating it
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              {error && (
                <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                  {error}
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="new-name">Business Name *</Label>
                <Input
                  id="new-name"
                  placeholder="Acme Design Studio"
                  autoFocus
                  {...register('name')}
                />
                {errors.name && (
                  <p className="text-sm text-destructive">{errors.name.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="new-email">Email</Label>
                <Input
                  id="new-email"
                  type="email"
                  placeholder="you@example.com"
                  {...register('email')}
                />
                {errors.email && (
                  <p className="text-sm text-destructive">{errors.email.message}</p>
                )}
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => router.replace('/settings/business')}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Create Business
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function EditBusinessView() {
  const { currentBusiness, refreshBusinesses, isLoading } = useBusiness()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<BusinessForm>({
    resolver: zodResolver(businessSchema),
    defaultValues: {
      name: currentBusiness?.name || '',
      legal_name: currentBusiness?.legal_name || '',
      email: currentBusiness?.email || '',
      phone: currentBusiness?.phone || '',
      website: currentBusiness?.website || '',
      address_line1: currentBusiness?.address_line1 || '',
      address_line2: currentBusiness?.address_line2 || '',
      city: currentBusiness?.city || '',
      state: currentBusiness?.state || '',
      postal_code: currentBusiness?.postal_code || '',
      country: currentBusiness?.country || '',
      tax_id: currentBusiness?.tax_id || '',
    },
  })

  // Businesses load asynchronously; sync the form once data arrives
  useEffect(() => {
    if (currentBusiness) {
      reset({
        name: currentBusiness.name || '',
        legal_name: currentBusiness.legal_name || '',
        email: currentBusiness.email || '',
        phone: currentBusiness.phone || '',
        website: currentBusiness.website || '',
        address_line1: currentBusiness.address_line1 || '',
        address_line2: currentBusiness.address_line2 || '',
        city: currentBusiness.city || '',
        state: currentBusiness.state || '',
        postal_code: currentBusiness.postal_code || '',
        country: currentBusiness.country || '',
        tax_id: currentBusiness.tax_id || '',
      })
    }
  }, [currentBusiness, reset])

  async function onSubmit(data: BusinessForm) {
    if (!currentBusiness) return

    setIsSubmitting(true)
    setMessage(null)

    const result = await updateBusinessProfileAction(currentBusiness.id, data)

    setIsSubmitting(false)

    if ('error' in result) {
      setMessage({ type: 'error', text: result.error })
    } else {
      setMessage({ type: 'success', text: 'Business settings updated' })
      refreshBusinesses()
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!currentBusiness) {
    return (
      <div className="p-6 lg:p-8">
        <div className="flex h-[400px] items-center justify-center">
          <div className="text-center">
            <h2 className="text-xl font-semibold">No business selected</h2>
            <p className="mt-2 text-muted-foreground">
              Create a business to get started.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 lg:p-8">
      <PageHeader
        title="Settings"
        description="Manage your business settings and preferences"
      />

      <div className="mt-6">
        <SettingsLayout>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
            {message && (
              <div
                className={cn(
                  'rounded-lg p-3 text-sm',
                  message.type === 'success'
                    ? 'bg-green-50 text-green-800'
                    : 'bg-red-50 text-red-800'
                )}
              >
                {message.text}
              </div>
            )}

            <Card>
              <CardHeader>
                <CardTitle>Business Information</CardTitle>
                <CardDescription>
                  Basic information about your business
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="name">Business Name *</Label>
                    <Input id="name" {...register('name')} />
                    {errors.name && (
                      <p className="text-sm text-destructive">{errors.name.message}</p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="legal_name">Legal Name</Label>
                    <Input
                      id="legal_name"
                      {...register('legal_name')}
                      placeholder="For invoices (if different)"
                    />
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Input id="email" type="email" {...register('email')} />
                    {errors.email && (
                      <p className="text-sm text-destructive">{errors.email.message}</p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="phone">Phone</Label>
                    <Input id="phone" {...register('phone')} />
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="website">Website</Label>
                    <Input id="website" {...register('website')} placeholder="https://" />
                    {errors.website && (
                      <p className="text-sm text-destructive">{errors.website.message}</p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="tax_id">Tax ID</Label>
                    <Input id="tax_id" {...register('tax_id')} placeholder="XX-XXXXXXX" />
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Business Address</CardTitle>
                <CardDescription>
                  This address will appear on your invoices
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="address_line1">Address Line 1</Label>
                  <Input id="address_line1" {...register('address_line1')} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="address_line2">Address Line 2</Label>
                  <Input id="address_line2" {...register('address_line2')} />
                </div>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="space-y-2">
                    <Label htmlFor="city">City</Label>
                    <Input id="city" {...register('city')} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="state">State</Label>
                    <Input id="state" {...register('state')} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="postal_code">Postal Code</Label>
                    <Input id="postal_code" {...register('postal_code')} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="country">Country</Label>
                    <Input id="country" {...register('country')} />
                  </div>
                </div>
              </CardContent>
            </Card>

            <div className="flex justify-end">
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Changes
              </Button>
            </div>
          </form>
        </SettingsLayout>
      </div>
    </div>
  )
}

function cn(...classes: (string | boolean | undefined)[]) {
  return classes.filter(Boolean).join(' ')
}
