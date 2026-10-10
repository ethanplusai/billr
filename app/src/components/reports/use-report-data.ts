'use client'

/**
 * Fetches the reports payload for the ACTIVE business.
 *
 * Scoping: the business comes from useBusiness() (the same context every other
 * page in (app) uses) and is passed to the RPC, which re-checks membership
 * server-side before it reads a row. Nothing here queries across businesses.
 *
 * Aggregation: one round trip to get_report_summary. The heavy sums, the time
 * series and the group-bys happen in Postgres; only the open-invoice rows come
 * back raw, because the aging report needs them for drill-down anyway.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useBusiness } from '@/lib/hooks/use-business'
import { parseReportPayload, type ReportData } from '@/lib/reports/types'
import type { BucketUnit, ReportRange } from '@/lib/reports/date-ranges'

export interface UseReportDataArgs {
  range: ReportRange
  previousRange: ReportRange | null
  bucket: BucketUnit
  /** Null lets the server fall back to the business's default currency. */
  currency: string | null
}

export interface UseReportDataResult {
  data: ReportData | null
  isLoading: boolean
  /** True while refetching with a payload already on screen, so charts can hold their frame. */
  isRefreshing: boolean
  error: string | null
  refresh: () => void
}

export function useReportData({
  range,
  previousRange,
  bucket,
  currency,
}: UseReportDataArgs): UseReportDataResult {
  const { currentBusiness } = useBusiness()
  const [data, setData] = useState<ReportData | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const hasData = useRef(false)

  const businessId = currentBusiness?.id ?? null
  const key = `${businessId}|${range.start}|${range.end}|${previousRange?.start ?? ''}|${previousRange?.end ?? ''}|${bucket}|${currency ?? ''}|${nonce}`

  useEffect(() => {
    let cancelled = false

    async function load() {
      if (!businessId) {
        setData(null)
        setIsLoading(false)
        return
      }

      if (hasData.current) setIsRefreshing(true)
      else setIsLoading(true)
      setError(null)

      try {
        const { createClient } = await import('@/lib/supabase/client')
        const supabase = createClient()
        const { data: payload, error: rpcError } = await supabase.rpc(
          'get_report_summary',
          {
            p_business_id: businessId,
            p_start: range.start,
            p_end: range.end,
            p_prev_start: previousRange?.start,
            p_prev_end: previousRange?.end,
            p_bucket: bucket,
            p_currency: currency ?? undefined,
            p_aging_limit: 500,
          },
        )

        if (cancelled) return
        if (rpcError) {
          console.error('useReportData:', rpcError)
          // Surface the underlying reason. A generic string here meant a
          // failure could not be diagnosed without database access, which is
          // the wrong trade for an operator looking at their own account.
          setError(
            rpcError.message
              ? `Could not load reports: ${rpcError.message}`
              : 'Could not load reports. Try again in a moment.',
          )
          return
        }

        setData(parseReportPayload(payload, range))
        hasData.current = true
      } catch (caught) {
        if (cancelled) return
        console.error('useReportData:', caught)
        const detail = caught instanceof Error ? caught.message : ''
        setError(
          detail
            ? `Could not load reports: ${detail}`
            : 'Could not load reports. Try again in a moment.',
        )
      } finally {
        if (!cancelled) {
          setIsLoading(false)
          setIsRefreshing(false)
        }
      }
    }

    load()
    return () => {
      cancelled = true
    }
    // `key` collapses every input that should trigger a refetch; the range and
    // previousRange objects are rebuilt each render, so depending on them
    // directly would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  return { data, isLoading, isRefreshing, error, refresh }
}
