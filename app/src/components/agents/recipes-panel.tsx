'use client'

import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { agentRecipes, type AgentRecipe } from '@/lib/agents/recipes'

function RecipeCard({ title, description, content }: AgentRecipe) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      toast.success('Copied to clipboard')
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Could not copy. Select the recipe text and copy it manually')
    }
  }

  return (
    <section>
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        {description}
      </p>
      <div className="relative mt-3">
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-4 pr-14 font-mono text-xs leading-relaxed text-slate-300">
          {content}
        </pre>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="absolute right-3 top-3 h-8 w-8"
          onClick={handleCopy}
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          <span className="sr-only">Copy recipe</span>
        </Button>
      </div>
    </section>
  )
}

export function RecipesPanel() {
  return (
    <div>
      <div>
        <h2 className="text-lg font-semibold text-foreground">Recipes</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Copy-paste patterns for your CLAUDE.md or AGENTS.md. Paste one into a repo and your
          agent follows it from then on.
        </p>
      </div>

      <div className="mt-6 space-y-10">
        {agentRecipes.map((recipe) => (
          <RecipeCard key={recipe.id} {...recipe} />
        ))}
      </div>

      <p className="mt-10 max-w-2xl border-t pt-6 text-sm leading-relaxed text-muted-foreground">
        These recipes run under your own agent, on your machine, with your API key. Billr does not
        run any automation on your behalf.
      </p>
    </div>
  )
}
