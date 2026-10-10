'use client'

import { useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { Copy, Check, ArrowUpRight, KeyRound } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  connectClients,
  CONSENT_SUMMARY,
  type ConnectCode,
  type ConnectStep,
} from '@/lib/agents/connect-instructions'
import { AGENT_DOCS_URL } from '@/lib/deployment'

const clients = connectClients()

function CodeCard({ code, id }: { code: ConnectCode; id: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(code.text)
      setCopied(true)
      toast.success('Copied')
    } catch {
      toast.error('Could not copy. Select the text and copy it manually.')
    }
  }
  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-zinc-200">
      <div className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 py-2">
        <span className="font-mono text-[10px] tracking-wide text-zinc-400">
          {code.label}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={copy}
          onBlur={() => setCopied(false)}
          aria-label={`Copy ${code.label}`}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span className="ml-2" aria-live="polite">
            {copied ? 'Copied' : 'Copy'}
          </span>
        </Button>
      </div>
      <pre
        tabIndex={0}
        className="overflow-x-auto p-5 font-mono text-xs leading-6 text-zinc-700"
      >
        <code id={id}>{code.text}</code>
      </pre>
    </div>
  )
}

function Steps({ steps, idPrefix }: { steps: ConnectStep[]; idPrefix: string }) {
  return (
    <ol className="mt-4 space-y-5">
      {steps.map((step, index) => (
        <li key={step.title} className="flex gap-3">
          <span
            aria-hidden
            className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-zinc-100 font-mono text-[10px] text-zinc-500"
          >
            {index + 1}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{step.title}</p>
            {step.detail && (
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                {step.detail}
              </p>
            )}
            {step.code && (
              <CodeCard code={step.code} id={`${idPrefix}-${index}`} />
            )}
          </div>
        </li>
      ))}
    </ol>
  )
}

export function ConnectPanel() {
  return (
    <div className="max-w-4xl space-y-8">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">
          Bring your agent into the workspace
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-500">
          Most clients only need the Billr MCP URL. {CONSENT_SUMMARY}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-zinc-200 bg-zinc-50/60 p-5">
        <div className="flex items-start gap-3">
          <KeyRound
            size={18}
            strokeWidth={1.5}
            className="mt-0.5 text-primary"
          />
          <div>
            <h3 className="text-sm font-medium">Connections and keys</h3>
            <p className="mt-1 text-xs leading-relaxed text-zinc-500">
              Every connected agent, and every manual key, is listed and
              revocable on the API Keys tab.
            </p>
          </div>
        </div>
        <Button asChild variant="outline">
          <Link href="/agents?tab=keys">
            Manage keys <ArrowUpRight size={13} className="ml-2" />
          </Link>
        </Button>
      </div>
      <Tabs defaultValue={clients[0].id}>
        <TabsList aria-label="Choose your agent" className="flex-wrap">
          {clients.map((client) => (
            <TabsTrigger key={client.id} value={client.id}>
              <Image
                src={`/agents/${client.mark}.svg`}
                alt=""
                width={17}
                height={17}
                className="mr-1"
              />
              {client.name}
            </TabsTrigger>
          ))}
        </TabsList>
        {clients.map((client) => (
          <TabsContent key={client.id} value={client.id} className="pt-5">
            <h3 className="text-sm font-medium">{client.title}</h3>
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">
              <span className="font-medium text-zinc-700">What you need: </span>
              {client.requirements}
            </p>

            <Steps steps={client.steps} idPrefix={client.id} />

            <div className="mt-6 rounded-lg bg-blue-50/50 px-4 py-3">
              <p className="text-xs font-medium text-zinc-700">Then verify</p>
              <p className="mt-1 text-sm leading-relaxed text-zinc-600">
                {client.verify}
              </p>
            </div>

            {client.fallback && (
              <details className="group mt-5 rounded-xl border border-zinc-200 p-4">
                <summary className="cursor-pointer text-sm font-medium text-zinc-700 marker:text-zinc-400">
                  {client.fallback.summary}
                </summary>
                <p className="mt-2 text-xs leading-relaxed text-zinc-500">
                  {client.fallback.detail}
                </p>
                <Steps
                  steps={client.fallback.steps}
                  idPrefix={`${client.id}-key`}
                />
              </details>
            )}

            {client.source && (
              <p className="mt-5 text-[11px] leading-relaxed text-zinc-400">
                Checked against{' '}
                <a
                  href={client.source}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2"
                >
                  the vendor documentation
                </a>{' '}
                on {client.verifiedOn}. If their menus have moved since, follow
                their wording and keep the URL above.
              </p>
            )}
          </TabsContent>
        ))}
      </Tabs>
      <div className="border-t border-zinc-100 pt-6">
        <Link
          href={AGENT_DOCS_URL}
          target="_blank"
          className="inline-flex items-center gap-2 text-xs font-medium text-primary"
        >
          Connection guide <ArrowUpRight size={13} />
        </Link>
      </div>
    </div>
  )
}
