# Billr (append to your AGENTS.md)

Codex reads `AGENTS.md` from your Codex home directory and from repositories,
with files closer to the working directory taking precedence. If you would
rather not install a plugin or a skill, paste the section below into the
`AGENTS.md` you already keep, and Codex will follow it whenever it touches
billing.

This file is deliberately **not** named `AGENTS.md`: dropping a file with that
name into a repository would override the project's own instructions. Copy the
section, do not copy the file.

The full instructions are in `plugins/codex/billr/skills/billr/SKILL.md`, with
the tool list in `references/tools.md` and the procedures in
`references/workflows.md`. The section below is the short form.

---

## Billing through Billr

Billr is reachable as the `billr` MCP server. Tools are listed in
`references/tools.md` next to this file; never guess a tool name.

**The one rule.** Read anything the connection is scoped to. Draft on request.
Never send a document to a client and never move recorded money without being
asked to, in the turn you are asked.

- Start with `list_businesses`, then `get_business` for currency and tax
  settings. Never assume a currency.
- `create_invoice` and `create_estimate` produce drafts. Leave them that way.
  `send_invoice` and `send_estimate` reach a client; call them only when told
  to send, naming the document, in that turn.
- When billing logged work, pass `time_entry_ids`, `expense_ids` or
  `engagement_entry_ids` and leave `line_items` out. The server prices the
  work and links the source records, so nothing is billed twice.
- State the client, amount and currency before any call that carries money,
  and say where the number came from. Never round, re-price or invent a rate.
- Write tools take a `request_id` UUID. Fresh id per intended operation; reuse
  the same id with identical input when retrying a call that may have half
  landed.
- `record_payment` records money that already arrived outside Billr, and only
  when the person has confirmed it landed. Corrections go through
  `update_payment` and `void_payment`, never an offsetting negative payment.
  Stripe-collected payments cannot be edited or voided: refund in Stripe, and
  the refund arrives back as its own ledger entry.
- Task billing: `list_billing_policies` (agents cannot approve pricing),
  `create_task`, `start_task`, `heartbeat_task` every 30 to 60 seconds,
  `pause_task` while waiting on a person, `record_task_usage` with a real
  provider cost and its source, then `complete_task`. A human approves before
  anything is invoiced.
- Engagements: `list_ready_to_bill` is the "what should I invoice today" list.
  Bill entries by passing `engagement_entry_ids` to `create_invoice`.
  `complete_engagement` cannot be reopened.
- Errors: 429 means the 120 requests per 60 seconds per key limit, so back off
  for `Retry-After`. "API key is expired, revoked or lacks permission for
  this tool" means stop and ask for a reconnect, not a retry.
- Never write a Billr key into a file, a commit or a reply. Use
  `bearer_token_env_var = "BILLR_API_KEY"` so the key stays in the
  environment.
