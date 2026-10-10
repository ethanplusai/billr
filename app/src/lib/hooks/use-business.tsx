'use client'

import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import type { Business, Profile } from '@/types'

interface BusinessContextValue {
  currentBusiness: Business | null
  businesses: Business[]
  profile: Profile | null
  isLoading: boolean
  setCurrentBusiness: (businessId: string) => void
  refreshBusinesses: () => Promise<void>
}

const BusinessContext = createContext<BusinessContextValue | undefined>(undefined)

const STORAGE_KEY = 'billr_current_business'

export function BusinessProvider({ children }: { children: React.ReactNode }) {
  const [businesses, setBusinesses] = useState<Business[]>([])
  const [currentBusiness, setCurrentBusinessState] = useState<Business | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const fetchBusinesses = useCallback(async () => {
    const { createClient } = await import('@/lib/supabase/client')
    const supabase = createClient()
    
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      setIsLoading(false)
      return
    }

    const { data: profileData } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single()
    
    if (profileData) {
      setProfile(profileData)
    }

    const { data: memberData } = await supabase
      .from('business_members')
      .select('business_id')
      .eq('user_id', user.id)

    if (!memberData || memberData.length === 0) {
      setBusinesses([])
      setCurrentBusinessState(null)
      setIsLoading(false)
      return
    }

    const businessIds = memberData.map(m => m.business_id)
    
    const { data: businessData } = await supabase
      .from('businesses')
      .select('*')
      .in('id', businessIds)
      .eq('is_active', true)
      .order('name')

    if (businessData) {
      setBusinesses(businessData)
      
      const savedBusinessId = localStorage.getItem(STORAGE_KEY)
      const savedBusiness = savedBusinessId 
        ? businessData.find(b => b.id === savedBusinessId) 
        : null
      
      setCurrentBusinessState(savedBusiness || businessData[0] || null)
    }

    setIsLoading(false)
  }, [])

  useEffect(() => {
    fetchBusinesses()
  }, [fetchBusinesses])

  const setCurrentBusiness = (businessId: string) => {
    const business = businesses.find(b => b.id === businessId)
    if (business) {
      setCurrentBusinessState(business)
      if (typeof window !== 'undefined') {
        localStorage.setItem(STORAGE_KEY, businessId)
      }
    }
  }

  const refreshBusinesses = async () => {
    await fetchBusinesses()
  }

  return (
    <BusinessContext.Provider
      value={{
        currentBusiness,
        businesses,
        profile,
        isLoading,
        setCurrentBusiness,
        refreshBusinesses,
      }}
    >
      {children}
    </BusinessContext.Provider>
  )
}

export function useBusiness() {
  const context = useContext(BusinessContext)
  if (context === undefined) {
    throw new Error('useBusiness must be used within a BusinessProvider')
  }
  return context
}
