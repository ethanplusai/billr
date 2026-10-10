'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { sendInvoiceEmail } from '@/lib/invoices/send-email'
import { sendEstimateEmail } from '@/lib/estimates/send-email'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function parseEmailList(input: string | undefined, label: string): string[] {
  if (!input?.trim()) return []
  const emails = input.split(',').map((e) => e.trim()).filter(Boolean)
  if (emails.length > 10) throw new Error(`At most 10 ${label} recipients are allowed`)
  for (const e of emails) {
    if (!EMAIL_RE.test(e)) throw new Error(`Invalid ${label} address: ${e}`)
  }
  return emails
}

export interface SendInvoiceOptions {
  requestId: string
  to: string
  cc?: string
  bcc?: string
  subject?: string
  message?: string
}

async function sendDocumentAction(
  invoiceId: string,
  options: SendInvoiceOptions,
  kind: 'invoice' | 'estimate'
): Promise<{ success: boolean; error?: string; to?: string }> {
  try {
    if ((options.subject?.length ?? 0) > 200 || (options.message?.length ?? 0) > 2000) throw new Error('Subject or message is too long')
    if (!process.env.RESEND_API_KEY) {
      throw new Error('Email is not configured (missing RESEND_API_KEY)')
    }
    if (!options.to || !EMAIL_RE.test(options.to.trim())) {
      throw new Error('Please enter a valid recipient email address')
    }
    const to = options.to.trim()
    const cc = parseEmailList(options.cc, 'Cc')
    const bcc = parseEmailList(options.bcc, 'Bcc')

    // RLS scopes this to invoices the signed-in user can access
    const supabase = await createClient()

    const sender = kind === 'invoice' ? sendInvoiceEmail : sendEstimateEmail
    const result = await sender(supabase, invoiceId, {
      requestId: options.requestId,
      to,
      cc,
      bcc,
      subject: options.subject,
      message: options.message,
    })

    revalidatePath(`/${kind}s`)
    revalidatePath(`/${kind}s/${invoiceId}`)
    return { success: true, to: result.to }
  } catch (err) {
    // Return the message so the client can show it: thrown server-action
    // errors are masked in production
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to send invoice',
    }
  }
}

export async function sendInvoiceAction(invoiceId: string, options: SendInvoiceOptions) {
  return sendDocumentAction(invoiceId, options, 'invoice')
}

export async function sendEstimateAction(estimateId: string, options: SendInvoiceOptions) {
  return sendDocumentAction(estimateId, options, 'estimate')
}
