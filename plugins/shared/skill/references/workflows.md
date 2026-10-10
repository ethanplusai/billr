# Billr workflows

These are the workflows Billr publishes for agents, restated for use through
the MCP server. They are written as procedures: follow the steps in order and
stop where the step says to stop.

Every one of them reads first and leaves anything that reaches a client as a
draft.

## Billable time logging

When a meaningful chunk of client-billable work finishes (a feature, a bug
fix, a review):

1. Estimate the hours the task actually took.
2. Call `log_time` with the client, a one-line description of the work, the
   date, and the hours.
3. Do not create or send an invoice. Logging time is the whole job here; an
   invoice run is a separate request.
4. If the client the work belongs to is unclear, ask before logging.

## Month-end invoice run

When the request is "run invoices for <month>":

1. Call `list_unbilled` per active client to see unbilled time and expenses
   grouped by client.
2. For each client with unbilled work, call `create_invoice` with that
   client's `time_entry_ids` and `expense_ids` from the list, and leave
   `line_items` out. The server prices the work and links the source records
   in one step. Do not invent, round or re-price a line.
3. Leave every invoice a **draft**. Never call `send_invoice` here.
4. Reply with a table: client, invoice total, and the dashboard link from the
   tool response, so the person can review and send from the app.

Anything already attached to a draft disappears from `list_unbilled`, so run
step 1 once per client and never re-pass an id you already billed.

## Overdue chase drafts

When the request is "check on overdue invoices":

1. Call `list_invoices` filtered to overdue status.
2. Call `get_invoice_link` per overdue invoice for the public URL.
3. Draft a short, friendly follow-up per **client** (not per invoice) quoting
   the invoice number, amount and due date, with the public link. Send
   nothing.
4. Put the drafts in the reply, one per client, to be edited and sent by the
   person.
5. Never mark an invoice paid or edit its terms here.

## Quote before you bill

When the request is "quote this" or "send me a number for this":

1. Confirm the client with `list_clients`. If the name is ambiguous or the
   client does not exist yet, ask before creating anything.
2. Call `list_items` and price the scope from the saved rate catalog wherever
   a line matches. Only invent a rate when nothing in the catalog fits, and
   say so explicitly when you do.
3. Call `create_estimate` with one line item per deliverable, keeping the
   descriptions in the person's words, not marketing language.
4. Stop at the draft. Never call `send_estimate`.
5. Reply with the line items, the total and the estimate number. If changes
   come back, use `update_draft_estimate` rather than creating a second
   estimate.
6. On acceptance, call `convert_estimate_to_invoice` when the whole amount is
   due at once, or `convert_estimate_to_engagement` when the work will be
   billed in parts. Leave the resulting invoice a **draft** and never call
   `send_invoice`. An estimate can become one or the other, never both.

## Payment status check

When the request is "where are we on payments", or about one invoice before
chasing it:

1. Call `list_invoices` filtered to sent and overdue status for the
   candidates.
2. Call `get_payment_status` per invoice rather than trusting the invoice
   total. It returns the payments ledger, the balance still due and a
   `mismatch` flag.
3. If `mismatch` is true on any invoice, stop and flag it by name. Report no
   paid amount for that invoice and do not chase it: the numbers disagree and
   a person needs to look.
4. Report the rest as a table: client, invoice number, amount paid, balance
   due, days overdue.
5. Never call `record_payment`, `send_invoice`, or anything that edits an
   invoice here. This one only reads.

## Rate catalog upkeep

When the request is "check the rate catalog", or a price has changed:

1. Call `list_items` and show the current saved items with their rates.
2. Call `list_invoices` for the last few months and point out line
   descriptions typed by hand that are not in the catalog yet, with the rate
   actually charged.
3. Propose the additions and rate changes as a list. Do not call
   `create_item` or `update_item` until told which to apply.
4. Apply exactly what was approved and nothing else. A saved rate changes what
   every future quote and invoice bills at, so never guess at a number.
5. This workflow never touches an invoice or an estimate.

## Task billing session

For agent work billed by active time and reported provider cost:

1. `list_billing_policies` for the human-approved rates, multipliers,
   currencies and budgets. Agents cannot approve pricing; if nothing fits,
   stop.
2. `create_task` with the `policy_id` and a title. It starts paused.
3. `start_task` when active work begins.
4. `heartbeat_task` every 30 to 60 seconds. Only the first 120 seconds after a
   heartbeat count. Retry with the same `request_id` so nothing counts twice.
5. `pause_task` while waiting on a person.
6. `record_task_usage` per known provider cost: provider, unique
   `provider_request_id`, cost in the policy currency, and the `source` the
   figure came from. Never estimate a cost.
7. `complete_task` once all usage is logged. It cannot be undone.
8. `get_task_billing_preview` to show the recorded time and usage. A human
   approves before anything is invoiced.

## Engagement billing run

When the request is "what should I invoice today" on agreed-total work:

1. Call `list_ready_to_bill`. It spans every client: deposits on started
   engagements, milestones marked complete, dated payments whose date has
   passed, final payments on completed engagements. Looking bills and sends
   nothing.
2. Call `get_engagement` on anything you are unsure about, to see the schedule
   and what has already been billed.
3. Call `create_invoice` with the `engagement_entry_ids` to bill. The server
   refuses to bill an entry twice.
4. Leave the invoice a **draft**.
5. `mark_milestone_complete` only when a milestone is genuinely delivered.
   `waive_engagement_entry` only when told an entry will not be charged.
   `complete_engagement` only when the work really is finished; it cannot be
   reopened.
