export interface AgentRecipe {
  id: string
  title: string
  description: string
  content: string
}

const timeLoggingRecipe = `## Billable time logging

When I finish a meaningful chunk of work in this repo (a feature, a bug fix,
a review, anything client-billable), log it to Billr before moving on:

1. Estimate the hours spent on the task you just completed.
2. Call \`log_time\` on the Billr MCP server, scoped to the "Acme Co" business,
   with the client name, a one-line description of the work, the date, and
   the hours.
3. Do not create or send an invoice. Just log the time. I'll ask for an
   invoice run separately.
4. If you're unsure which client the work belongs to, ask me before logging.
`

const monthEndRecipe = `## Month-end invoice run

When I say "run invoices for <month>" or on the last business day of the
month if I ask for the routine:

1. Call \`list_unbilled\` for each active client to see unbilled time and
   expenses grouped by client.
2. For each client with unbilled work, call \`create_invoice\` with that
   client's \`time_entry_ids\` and \`expense_ids\` from the list, and leave
   \`line_items\` out. The server prices and links the source work in one
   step; do not invent, round, or re-price a line.
3. Leave every invoice as a **draft**. Never call \`send_invoice\` as part of
   this recipe.
4. Reply with a summary table: client, invoice total, and the dashboard link
   from the tool response, so I can review and send from the app.

Anything already attached to a draft disappears from \`list_unbilled\`, so run
step 1 once per client and never re-bill an id you already passed in.
`

const overdueChaseRecipe = `## Overdue chase drafts

When I say "check on overdue invoices":

1. Call \`list_invoices\` filtered to overdue status.
2. For each overdue invoice, call \`get_invoice_link\` to get the public
   invoice URL.
3. Draft a short, friendly follow-up email per client (not per invoice) that
   references the invoice number, amount, and due date, and includes the
   public link. Do not send anything.
4. Paste the drafts back to me in chat, one per client, so I can edit and
   send them myself, or forward them for me to send from the dashboard.
5. Never mark an invoice as paid or edit its terms as part of this recipe.
`

const quoteBeforeYouBillRecipe = `## Quote before you bill

When I describe a new piece of work and say "quote this" or "send me a
number for this":

1. Confirm the client with \`list_clients\`. If the name is ambiguous or the
   client does not exist yet, ask me before creating anything.
2. Call \`list_items\` first and price the scope from the saved rate catalog
   wherever a line matches. Only invent a rate when nothing in the catalog
   fits, and say so explicitly when you do.
3. Call \`create_estimate\` with one line item per deliverable. Keep the
   descriptions in my words, not marketing language.
4. Stop at the draft. Never call \`send_estimate\`. The quote goes to a client
   only after I have read it.
5. Reply with the line items, the total, and the estimate number so I can
   approve or adjust. If I ask for changes, use \`update_draft_estimate\`
   rather than creating a second estimate.
6. Later, when I tell you the client accepted, call
   \`convert_estimate_to_invoice\` on that estimate id. Leave the resulting
   invoice as a **draft** and never call \`send_invoice\`. Reply with the
   invoice number so I can send it from the dashboard.
`

const paymentStatusRecipe = `## Payment status check

When I say "where are we on payments" or ask about a specific invoice
before I chase it:

1. Call \`list_invoices\` filtered to sent and overdue status to get the
   candidates.
2. For each one, call \`get_payment_status\` rather than trusting the invoice
   total alone. It returns the payments ledger, the balance still due, and a
   mismatch flag.
3. If \`mismatch\` is true on any invoice, stop and flag it to me by name.
   Do not report a paid amount for that invoice and do not chase it. The
   numbers disagree and I need to look at it myself.
4. Report the rest as a short table: client, invoice number, amount paid,
   balance due, and days overdue.
5. Never call \`record_payment\`, \`send_invoice\`, or anything that edits an
   invoice from this recipe. This one only reads.
`

const rateCatalogRecipe = `## Rate catalog upkeep

When I say "check the rate catalog" or when I mention that a price has
changed:

1. Call \`list_items\` and show me the current saved items with their rates.
2. Call \`list_invoices\` for the last few months and point out any line
   description I keep typing by hand that is not in the catalog yet, along
   with the rate I actually charged for it.
3. Propose the additions and the rate changes to me as a list. Do not call
   \`create_item\` or \`update_item\` until I say which ones to apply.
4. When I approve, apply exactly what I approved and nothing else. Changing
   a saved rate changes what future quotes and invoices bill at, so never
   guess at a number.
5. This recipe never touches an invoice or an estimate. It only maintains
   the catalog they bill from.
`

export const agentRecipes: AgentRecipe[] = [
  {
    id: 'billable-time-logging',
    title: 'Billable time logging',
    description:
      'Logs time as you finish work in a repo, so unbilled hours never pile up silently. It only calls log_time and never creates or sends anything, so there\'s nothing for the agent to get wrong on the money side.',
    content: timeLoggingRecipe,
  },
  {
    id: 'month-end-invoice-run',
    title: 'Month-end invoice run',
    description:
      'Pulls everything unbilled per client and drafts invoices from it once a month. Every invoice lands as a draft. The agent never calls send_invoice, so nothing reaches a client without you looking at it first.',
    content: monthEndRecipe,
  },
  {
    id: 'overdue-chase-drafts',
    title: 'Overdue chase drafts',
    description:
      'Finds overdue invoices and writes the follow-up emails for you, but stops at drafting. The agent never sends the email or touches invoice status. You decide what goes out and when.',
    content: overdueChaseRecipe,
  },
  {
    id: 'quote-before-you-bill',
    title: 'Quote before you bill',
    description:
      'Turns a described scope into a priced estimate off your saved rates, then stops. The agent never calls send_estimate, and when the client accepts it converts to a draft invoice you still have to send yourself.',
    content: quoteBeforeYouBillRecipe,
  },
  {
    id: 'payment-status-check',
    title: 'Payment status check',
    description:
      'Reads the real payments ledger per invoice instead of the invoice total, so you find out what has actually landed. It is read-only, and it refuses to report a number when the ledger and the invoice disagree.',
    content: paymentStatusRecipe,
  },
  {
    id: 'rate-catalog-upkeep',
    title: 'Rate catalog upkeep',
    description:
      'Keeps saved items in sync with what you are really charging, so quotes and invoices stop being priced from memory. The agent proposes every change and waits for your approval before writing anything.',
    content: rateCatalogRecipe,
  },
]
