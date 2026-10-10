'use client'

import { useEffect, useState, useRef } from 'react'
import { toast } from 'sonner'
import { Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { sendInvoiceAction, sendEstimateAction } from '@/lib/actions/send-invoice'
import { parseDay } from '@/lib/dates'

interface SendInvoiceDialogProps {
  kind?: 'invoice' | 'estimate'
  open: boolean
  onOpenChange: (open: boolean) => void
  invoiceId: string
  invoiceNumber: string
  defaultEmail: string | null
  businessName: string
  amountDue: number
  currency: string
  dueDate: string
  primaryColor?: string | null
  onSent?: () => void
}

const formatCurrency = (amount: number, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount)

const formatDate = (date: string) =>
  parseDay(date).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })

export function SendInvoiceDialog({
  kind = 'invoice',
  open,
  onOpenChange,
  invoiceId,
  invoiceNumber,
  defaultEmail,
  businessName,
  amountDue,
  currency,
  dueDate,
  primaryColor,
  onSent,
}: SendInvoiceDialogProps) {
  const label = kind === 'invoice' ? 'Invoice' : 'Estimate'
  const defaultSubject = `${label} ${invoiceNumber} from ${businessName}`
  const defaultMessage = `Hi,

Here's your ${kind} from ${businessName}.

${label}: ${invoiceNumber}
Amount due: ${formatCurrency(amountDue, currency)}
Due date: ${formatDate(dueDate)}

You can view the invoice and full details using the button below.

Thank you!`

  const [to, setTo] = useState(defaultEmail || '')
  const [cc, setCc] = useState('')
  const [bcc, setBcc] = useState('')
  const [subject, setSubject] = useState(defaultSubject)
  const [message, setMessage] = useState(defaultMessage)
  const [isSending, setIsSending] = useState(false)

  // Re-prefill whenever the dialog opens for a (possibly different) invoice
  useEffect(() => {
    if (open) {
      setTo(defaultEmail || '')
      setSubject(defaultSubject)
      setMessage(defaultMessage)
      setCc('')
      setBcc('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, invoiceId])

  const deliveryRequest = useRef<{input:string;id:string} | null>(null)
  const handleSend = async () => {
    setIsSending(true)
    try {
      const send = kind === 'invoice' ? sendInvoiceAction : sendEstimateAction
      const input = JSON.stringify({to,cc,bcc,subject,message})
      if (!deliveryRequest.current || deliveryRequest.current.input !== input) deliveryRequest.current = {input,id:crypto.randomUUID()}
      const result = await send(invoiceId, {
        requestId: deliveryRequest.current.id,
        to: to.trim(),
        cc: cc.trim() || undefined,
        bcc: bcc.trim() || undefined,
        subject: subject.trim() || undefined,
        message: message.trim() || undefined,
      })
      if (result.success) {
        toast.success(`${label} ${invoiceNumber} sent to ${result.to}`)
        onOpenChange(false)
        onSent?.()
      } else {
        toast.error(result.error || 'Failed to send invoice')
      }
    } catch {
      toast.error('Failed to send invoice')
    } finally {
      setIsSending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Send {invoiceNumber}</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="compose">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="compose">Compose</TabsTrigger>
            <TabsTrigger value="preview">Preview</TabsTrigger>
          </TabsList>
          <TabsContent value="compose" className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label htmlFor="send-to">To</Label>
              <Input
                id="send-to"
                type="email"
                placeholder="client@example.com"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="send-cc">Cc</Label>
                <Input
                  id="send-cc"
                  placeholder="Optional, comma separated"
                  value={cc}
                  onChange={(e) => setCc(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="send-bcc">Bcc</Label>
                <Input
                  id="send-bcc"
                  placeholder="Optional, comma separated"
                  value={bcc}
                  onChange={(e) => setBcc(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="send-subject">Subject</Label>
              <Input
                id="send-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="send-message">Message</Label>
              <Textarea
                id="send-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={7}
                className="font-mono text-sm"
              />
            </div>
          </TabsContent>
          <TabsContent value="preview" className="pt-2">
            <div className="max-h-[420px] overflow-y-auto rounded-lg border bg-muted/40 p-4">
              <div className="mx-auto max-w-md rounded-xl bg-background p-6 shadow-sm">
                <h2 className="text-lg font-bold">{businessName}</h2>
                <p className="mb-4 text-sm text-muted-foreground">
                  {label} {invoiceNumber}
                </p>
                {message && (
                  <p className="mb-4 whitespace-pre-wrap text-sm">{message}</p>
                )}
                <div className="mb-4 rounded-lg bg-muted p-4">
                  <p className="text-xs text-muted-foreground">Amount due</p>
                  <p className="text-2xl font-bold">
                    {formatCurrency(amountDue, currency)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Due {formatDate(dueDate)}
                  </p>
                </div>
                <div
                  className="rounded-lg p-3 text-center text-sm font-semibold text-white"
                  style={{ backgroundColor: primaryColor || '#2563eb' }}
                >
                  View {label}
                </div>
                <p className="mt-4 text-center text-xs text-muted-foreground">
                  Sent via Billr
                </p>
              </div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              The email also includes the invoice line items below the amount.
            </p>
          </TabsContent>
        </Tabs>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSending}
          >
            Cancel
          </Button>
          <Button onClick={handleSend} disabled={isSending || !to.trim()}>
            <Send className="mr-2 h-4 w-4" />
            {isSending ? 'Sending...' : `Send ${label}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
