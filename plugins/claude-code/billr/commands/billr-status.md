---
description: Read-only Billr summary: unbilled work, what is ready to bill, and where payments stand. Writes nothing and sends nothing.
disable-model-invocation: true
---

# Billr status

Produce a read-only picture of the billing position. **This command writes
nothing and sends nothing.** Do not call any tool outside the list below, and
do not offer to create, edit, send or record anything unless asked afterwards.

If the user typed anything after the command, treat it as a filter (a client
name, a month, "overdue only"): `$ARGUMENTS`

Steps:

1. `list_businesses`. If more than one comes back and the arguments do not
   name one, ask which business before going further.
2. `list_unbilled` for the business, for unbilled time and expenses grouped by
   client.
3. `list_ready_to_bill` for engagement schedule entries that are billable now.
4. `list_invoices` filtered to sent and overdue.
5. `get_payment_status` for each invoice from step 4, rather than trusting the
   invoice total. It returns the payments ledger, the balance still due and a
   `mismatch` flag.
6. `revenue_summary` for the current period.

Then report, in this order:

- **Unbilled work**: client, hours or expense count, and the value, with a
  total.
- **Ready to bill**: engagement, entry label and amount.
- **Outstanding**: client, invoice number, amount paid, balance due, days
  overdue.
- **This period**: the revenue summary figures.

Rules for the report:

- Name the currency on every figure. Take it from the tool responses; never
  assume.
- If `mismatch` is true on any invoice, call it out by name and report **no**
  paid figure for it. The ledger and the invoice disagree and a person needs
  to look at it.
- If a tool is missing from the tool list, the connection was not granted that
  permission. Say which section you could not fill in and why.
- If a rate limit (429) comes back, say so and report what you did gather
  rather than retrying in a loop.
- End with one line naming what a person might want to do next. Do not do it.
