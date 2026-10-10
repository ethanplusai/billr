# Fresh machine test

A complete installation test on a computer that has never run Billr. Work through it top to bottom. Each step says what a pass looks like; if what you see differs, stop and note the step number, what you ran and what you saw.

Allow about an hour. Steps 1 to 13 are required; 14 to 16 are optional; 17 cleans up.

## 0. Prerequisites

| Tool | Version | Check |
| --- | --- | --- |
| Git | any recent | `git --version` |
| Node.js | 22 or newer | `node --version` prints `v22` or higher |
| Docker Desktop (or Docker Engine) | running; at least 4 GB of memory for the production image | `docker info` succeeds |
| Supabase CLI | 2.67.1 or newer | `supabase --version` |

Install links: [Node.js](https://nodejs.org/), [Docker Desktop](https://docs.docker.com/desktop/), [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started).

## 1. Clone

```sh
git clone https://github.com/ethanplusai/billr.git
cd billr/app
```

Pass: the clone finishes and `ls` shows `package.json`, `Dockerfile` and `scripts`.

## 2. Check the machine

```sh
npm run doctor
```

Pass: no `FAIL` lines, and the last line reads `Ready. Next: npm ci, then npm run setup:local.` A `WARN` about Docker memory only matters for step 16.

If a port is busy, the `FAIL` line names the variable to set. For example, when another program already uses port 3000, run `BILLR_LOCAL_APP_PORT=3010 npm run doctor`, and put the same prefix on `npm run setup:local` in step 4. Everywhere below, replace `3000` with the port you chose.

## 3. Install dependencies

```sh
npm ci
```

Pass: exits without an error and prints `added ... packages`.

## 4. Start the local database

```sh
npm run setup:local
ls -l .env.local
```

Pass: the command prints `Created private .env.local.` followed by the command that starts Billr (the first run downloads images and can take several minutes), and `ls` shows `-rw-------` for `.env.local`.

## 5. Start Billr

```sh
npm run dev -- --hostname 127.0.0.1
```

If you chose another port in step 2, use the command step 4 printed instead: it adds `--port`.

Open http://localhost:3000. Pass: the terminal prints `Ready`, and the browser lands on the sign-in page.

## 6. Sign up as the owner

Choose **Sign up**. Use a made-up name and address such as `owner@fieldstone.example` and a password of at least 8 characters.

Pass: you reach the onboarding page that asks for your business name. The local database sends no confirmation email.

## 7. Sign-up is now closed

In a private browser window, open http://localhost:3000/signup.

Pass: the page says "Sign-up is closed" and shows no form. Close the private window.

## 8. Create a business

Name it `Fieldstone Digital`, leave or fill in the business email, and continue.

Pass: you land on the dashboard with zero totals. A short tour opens the first time; skip it or step through it. **Settings** shows exactly four tabs: Business, Branding, Invoices, Account.

## 9. Add a client

**Clients**, **Add Client**: name `Harbor & Lane`, email `billing@harborlane.example`. Choose **Create Client**.

Pass: the client appears in the list with a total invoiced of $0.00.

## 10. Create an invoice

**Invoices**, **New Invoice**: client Harbor & Lane, one line `Website retainer`, quantity 1, rate 1500. Optionally fill in **Payment Instructions**. Choose **Save & Send**. The invoice is saved and a send dialog opens; close it, because email is not set up yet (step 15). Then open the **...** menu and choose **Mark as Sent**: a draft has no client page, and marking it sent is how you issue an invoice you deliver yourself.

Pass: the invoice shows status sent, the business's first invoice number (`INV-0001`) and a total of $1,500.00.

## 11. Download the PDF

On the invoice, open the **...** menu and choose **Download PDF**.

Pass: a PDF downloads and shows Fieldstone Digital, Harbor & Lane, the line item and 1,500.00.

## 12. Open the client's view

From the invoice's **...** menu choose **Copy Link**, and open the link in a private browser window.

Pass: the page loads without signing in and shows the amount due, a payment section with the invoice's payment instructions (or "Contact the sender to arrange payment" when it has none, because card payments are not set up yet) and a **Download PDF** button.

## 13. Record a payment and connect an agent

Back on the invoice, open the **...** menu, choose **Record Payment**, and record 500 by bank transfer. You land on the Payments list; open the invoice again.

Pass: the status is partial and the balance due $1,000.00.

Open **Agents**, **Connect**. Pass: the MCP URL shown is `http://localhost:3000/api/mcp`. With Claude Code installed:

```sh
claude mcp add --transport http billr-local http://localhost:3000/api/mcp
```

Run `/mcp` in Claude Code, choose `billr-local`, sign in and approve. Pass: the consent page asks which business and which permissions, and `claude mcp list` shows `billr-local` as connected.

## 14. Optional: card payments through your Stripe account (test mode)

Needs a Stripe account in test mode and the [Stripe CLI](https://docs.stripe.com/stripe-cli). Stop the dev server. In `.env.local` set `STRIPE_SECRET_KEY` (`sk_test_...`) and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (`pk_test_...`). In a second terminal run:

```sh
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

Copy the `whsec_...` secret it prints into `STRIPE_WEBHOOK_SECRET` and start the dev server again. **Agents**, **Payments** now says card payments are on, in test mode. Open the invoice's public link and pay the balance with card `4242 4242 4242 4242`, any future expiry, any CVC.

Pass: the payment succeeds, the `stripe listen` terminal shows `payment_intent.succeeded` answered with 200, and the invoice becomes paid.

## 15. Optional: invoice email through Resend

Needs your own Resend account and a verified sending domain. Stop the dev server, add to `.env.local`:

```
RESEND_API_KEY=re_your_key
RESEND_INVOICE_FROM=Fieldstone Digital <invoices@your-verified-domain.example>
```

Start the dev server again, change the client's email to an address you own, and use **Send Invoice** on an invoice.

Pass: the email arrives at your address with the invoice PDF attached.

## 16. Optional: the production container

Follow "Trying the container against the local development database" in [self-hosting.md](self-hosting.md). Stop the dev server first. If you chose another app port in step 2, also set `BILLR_PORT` to it, so the container listens on the address `.env.local` names.

Pass: `docker compose --env-file .env.local ps` reports the app `healthy`, and you can sign in at http://localhost:3000 and see Harbor & Lane.

## 17. Clean up

```sh
docker compose --env-file .env.local down
supabase stop --workdir .self-host/billr-local-56421
```

Pass: both commands finish. Your local data stays until you delete the Docker volumes yourself.

## Reporting

For each step write PASS or FAIL. For a FAIL, include the step number, the command or click, the exact message, and your operating system, `node --version` and `supabase --version`. Never paste the contents of `.env.local`.
