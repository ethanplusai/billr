# Running Billr

Billr is an internal tool: your business runs it for itself. This guide covers the local installation on your own computer and a production installation on a server, connected to a Supabase project you own. There is no shared Billr database, account, API key or payment platform.

`/` opens the workspace for a signed-in user and the sign-in page otherwise. There is no homepage.

## Local installation

Follow the quick start in the README, or [fresh-machine-test.md](fresh-machine-test.md) for a step-by-step run with what success looks like at each step. Run `npm run doctor` first to check Node.js, Docker, the Supabase CLI and the ports.

`npm run setup:local` starts a dedicated Supabase project on ports 56420 to 56429, applies the schema and writes `app/.env.local` with mode 0600. It refuses to overwrite existing configuration. `BILLR_LOCAL_APP_PORT` and `BILLR_LOCAL_DB_PORT` override the app port and the base API port. `BILLR_SUPABASE_CLI` names the Supabase CLI binary that setup:local and doctor run, for example a pinned copy outside your PATH (default `supabase`). Do not reuse development credentials on the internet.

Stop the local backend without deleting data:

```sh
supabase stop --workdir .self-host/billr-local-56421
```

The CLI may publish database ports beyond loopback; keep this stack on a trusted machine behind a firewall. It is not a production configuration.

## Production backend: your Supabase

Provision an empty Supabase project you own, or follow the official [Supabase Docker self-hosting guide](https://supabase.com/docs/guides/self-hosting/docker) on infrastructure you control. Billr's Compose file runs the **application**, not a second copy of Supabase.

For a self-hosted backend, generate new production secrets using Supabase's instructions; do not keep example passwords or JWT secrets. Serve the public API over HTTPS, restrict the database and Studio to administrators, and enable Auth, PostgREST and Storage. Preserve both the database and the Storage volumes.

Apply the migrations in `app/supabase/migrations` with the Supabase CLI: one baseline, `00001_baseline.sql`, and any numbered migrations after it. From `app`, with `BILLR_DATABASE_URL` set in your shell to your backend's direct Postgres connection string:

```sh
supabase db push --db-url "$BILLR_DATABASE_URL" --include-all
```

Use an empty database for a first installation. The baseline includes the tables, the authorization rules, the functions and the storage buckets and policies. No seed data is required.

## Configure the application

From `app`:

```sh
cp .env.example .env.local
chmod 600 .env.local
```

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_APP_URL` | Your HTTPS origin, for example `https://invoices.example.org`, without a path. |
| `NEXT_PUBLIC_SUPABASE_URL` | Your public HTTPS Supabase API origin. Browsers must reach it. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Your public anon or publishable key. Never a service-role or secret key. |
| `SUPABASE_SERVICE_ROLE_KEY` | Your service-role or secret key. Server only; never a build argument. |
| `SUPABASE_INTERNAL_URL` | Optional server-to-server API origin for the **same** backend. Browsers still use the public URL. |
| `BILLR_OPEN_SIGNUP` | Optional. `true` keeps sign-up open after the first account. See below. |
| `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | Optional card payments. All three or none. See below. |
| `RESEND_API_KEY`, `RESEND_INVOICE_FROM` | Optional invoice email. See below. |
| `BILLR_EMAIL_DAILY_LIMIT` | Optional cap on emails per business per 24 hours. |
| `BILLR_TRUSTED_IP_HEADER` | Optional. See "Client addresses and rate limits". |

Configure Supabase Auth's site URL to your app origin, and allow your origin's `/api/auth/callback` as a redirect URL. Configure authentication SMTP for a production installation so password reset email arrives.

## Sign-up and teammates

The first person to sign up owns the installation. After that, sign-up is closed:

- the sign-up page says so and shows no form;
- a new account created through **Continue with GitHub** or **Google** is signed out at once;
- the database refuses to create a business for an account the installation never admitted, even when someone calls it directly with your public key.

Sign up as the owner right after you install, before anyone else can reach the address. If you turn on email confirmations in Supabase Auth, the account counts as the first one as soon as the sign-up form is submitted, before the address is confirmed, so an unconfirmed sign-up by someone else could otherwise claim the installation.

Once your owner account exists, also turn off **Allow new users to sign up** in your Supabase project (Authentication, Sign In / Providers) for a production installation. Billr already refuses new accounts, but with that switch off nobody can even create an account in Supabase Auth. On the local stack the matching setting is `enable_signup` under `[auth]` in `.self-host/billr-local-56421/supabase/config.toml`, the copy `npm run setup:local` made.

To give a teammate a login:

1. Set `BILLR_OPEN_SIGNUP=true`, restart Billr (and turn **Allow new users to sign up** back on in Supabase if you turned it off).
2. Ask them to sign up.
3. Set `BILLR_OPEN_SIGNUP` back to empty (or remove it), restart, and turn the Supabase switch off again.
4. Add them to a business. There is no invite screen yet, so this is a database step, in the Supabase SQL editor:

```sql
insert into public.business_members (business_id, user_id, role)
select b.id, u.id, 'member'
from public.businesses b, auth.users u
where b.name = 'Fieldstone Digital' and u.email = 'teammate@fieldstone.example';
```

Use `admin` instead of `member` for someone who may approve task pricing. You can also create the user yourself in Supabase Studio (Authentication, Add user) and skip steps 1 to 3: an account that belongs to a business is admitted when it first signs in.

Removing someone from a business does not take away their login. An admitted account stays admitted: they can still sign in, but they see no businesses. To stop them signing in at all, delete the user in Supabase Studio (Authentication, Users). The database refuses to delete a user whose actions appear in Billr's audit trails (agent tool calls, payment corrections, task events, task pricing approvals in `billing_policies.approved_by`), because those records are kept.

## Optional: GitHub and Google sign-in

The sign-in and sign-up pages show a GitHub or Google button only when your Supabase project has that provider enabled, so enabling one needs no redeployment.

- **GitHub:** create a GitHub OAuth App (GitHub Settings, Developer settings, OAuth Apps). Set the Authorization callback URL to your Supabase project's `/auth/v1/callback` (not the Billr route). In Supabase, Authentication, Sign In / Providers, GitHub: enable it and enter the client id and secret. Billr asks for authentication only, with no repository access.
- **Google:** create an OAuth client of type Web application in Google Cloud. Add your Supabase project's `/auth/v1/callback` as an authorised redirect URI, then enable Google in Supabase with that client id and secret.

Supabase then returns to your Billr at `/api/auth/callback`, which must be in Supabase's allowed redirect URLs. Provider secrets live only in Supabase, never in Billr's environment. Sign-up closure applies to these buttons too.

## Build and run

Building the image compiles Next.js with a 3 GB heap, so give Docker at least 4 GB of memory, and 6 GB if it runs anything else (Docker Desktop: Settings, Resources, Memory). The running container needs far less. On a smaller build host, lower the heap with `BILLR_BUILD_HEAP_MB=2048 docker compose --env-file .env.local build`; below about 2 GB the build runs out of memory.

Run from `app`:

```sh
npm ci
npm run check:config
docker compose --env-file .env.local build
docker compose --env-file .env.local up -d
docker compose --env-file .env.local ps
```

The container runs as a non-root user and binds only `127.0.0.1:3000` on the host by default; set `BILLR_PORT` in your shell to use another host port. Put your HTTPS reverse proxy in front of it. Forward the original Host and scheme, and pass streaming HTTP through `/api/mcp` without buffering. Do not expose the database, Studio or service-role interfaces. `/api/health` is liveness only.

**Client addresses and rate limits.** Sign-in lockouts and the public payment links are limited per caller address, and that address comes from a proxy header. Your proxy must APPEND the real peer to `X-Forwarded-For` (nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`), because Billr reads the last entry, the only one a client cannot choose. If your proxy instead OVERWRITES a single-value header, name it in `BILLR_TRUSTED_IP_HEADER` (for example `X-Real-IP` with `proxy_set_header X-Real-IP $remote_addr;`). Never name a header your proxy passes through unchanged. With neither configured, every caller shares one bucket, so limits still hold but are shared.

`NEXT_PUBLIC_*` values are compiled into the browser code. Rebuild whenever public URLs or the Stripe publishable key change. Server secrets arrive at runtime through `.env.local`, which is excluded from the Docker build context.

If the backend is on the same host, `127.0.0.1` inside the app container refers to the container. Use your public API hostname or a correctly configured `SUPABASE_INTERNAL_URL` and Docker network; both API URLs must identify the same project. The container refuses to start with a loopback `NEXT_PUBLIC_SUPABASE_URL` and no `SUPABASE_INTERNAL_URL`, and says so in `docker compose logs app`.

### Trying the container against the local development database

To try the production image on your own machine before you have a real backend, point it at the database `npm run setup:local` started. Your browser keeps using `http://127.0.0.1:56421`; the container's own server calls go to `host.docker.internal`, which Compose maps to your machine on macOS, Windows and Linux. Stop `npm run dev` first, because both use the same port. If you gave setup:local a `BILLR_LOCAL_APP_PORT`, also `export BILLR_PORT=` that port, so the container answers where `NEXT_PUBLIC_APP_URL` points. From `app`:

```sh
export SUPABASE_INTERNAL_URL=http://host.docker.internal:56421
docker compose --env-file .env.local build
docker compose --env-file .env.local up -d
docker compose --env-file .env.local ps
```

The variable comes from your shell, so `.env.local` stays usable for `npm run dev`. `ps` should report the app as `healthy` within a minute; then sign in at http://localhost:3000 (or your `BILLR_PORT`) with the account you created in development. In this setup, invoice PDFs render without your logo: the PDF renderer only fetches logos from the public storage origin, and that origin is loopback here. This recipe is for trying the image locally; it is not a production configuration.

## Taking card payments

Card payments run on your own Stripe account, and every business on the installation uses it. Clients pay on the invoice page with Stripe's Payment Element; the amount is always taken from the invoice on the server.

1. In the Stripe Dashboard, open Developers, API keys. Copy the publishable key (`pk_...`) and the secret key (`sk_...`). Start with test keys.
2. Open Developers, Webhooks and add an endpoint at `https://YOUR_APP/api/stripe/webhook` that sends `payment_intent.succeeded`, `payment_intent.payment_failed`, `charge.refunded` and `charge.dispute.created`. Create it as an endpoint for your own account, not for connected accounts. Copy its signing secret (`whsec_...`).
3. Set `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` and `STRIPE_WEBHOOK_SECRET`, all from the same mode (test or live), and restart. A Docker image must be rebuilt, because the publishable key is compiled into the browser code. `npm run check:config` refuses a partial or mixed-mode set.

**Agents → Payments** shows whether card payments are on, in which mode, and the webhook URL to use. On your own computer, the Stripe CLI forwards events instead of a webhook endpoint: `stripe listen --forward-to localhost:<your app port, 3000 by default>/api/stripe/webhook` prints a signing secret to use as `STRIPE_WEBHOOK_SECRET`. Test the whole loop with card `4242 4242 4242 4242` before switching to live keys: a payment, a partial payment, a refund and a dispute from the Stripe dashboard.

Without Stripe keys everything else works; you record payments as they arrive.

## Invoice email

Email is optional. Without it, everything works except sending documents from Billr: choose **Mark as Sent** in an invoice's or estimate's **...** menu, then share the public link or the PDF yourself. A draft has no public page. To turn it on, set `RESEND_API_KEY` and `RESEND_INVOICE_FROM` to an address on a domain you verified in your own Resend account. `npm run check:config` refuses a Resend key without a sender. `BILLR_EMAIL_DAILY_LIMIT` optionally caps how many documents one business may email per 24 hours. Authentication email (sign-up confirmation, password reset) is configured separately, as SMTP in your Supabase project.

## Verify the installation

1. Sign up, finish onboarding and add a fictional client.
2. Open `/signup` in a private window: it says sign-up is closed.
3. Create an invoice and an estimate, log time and expenses, and record an external partial payment.
4. Check Reports and download a PDF. Confirm links use your origin.
5. Create a read and draft key. Connect an agent using the URL shown in **Agents → Connect**. Confirm it cannot send or record payments. Revoke it and confirm access stops.
6. Approve a task pricing policy, log a task, review costs and draft an invoice.
7. Inspect browser network requests: database calls go to your Supabase URL, and providers appear only when you use their integrations.

Automated local MCP acceptance (fictional writes, never live), from `app` after local setup:

```sh
DOTENV_CONFIG_PATH=.env.local node scripts/local-mcp-acceptance.mjs
```

The script finds the app at the `NEXT_PUBLIC_APP_URL` that setup:local wrote, so a `BILLR_LOCAL_APP_PORT` needs nothing more; `BILLR_LOCAL_APP_URL` overrides the MCP URL. If you chose another `BILLR_LOCAL_DB_PORT` for setup:local, pass the same `BILLR_LOCAL_DB_PORT` here. The SQL tests in `supabase/tests` run against the checked-in test stack: `supabase start`, then `npm run test:sql`. `BILLR_SQL_CONTAINER` names the database container the tests run in, when it is not the default `supabase_db_<project_id>` from `supabase/config.toml`.

## Upgrades, backups and recovery

Back up your Postgres data, Supabase Auth data and configuration, Storage objects and your secrets using your backend's supported backup process. A database dump alone does not include uploaded logos. Test a restore into a separate installation before you depend on the backup.

Before an upgrade: read [CHANGELOG.md](../CHANGELOG.md), test against a restored copy, back up, apply pending migrations with `supabase db push`, rebuild with your own public config, and repeat the checks above. Never edit a migration that has been applied. Rolling back the app image does not roll back a schema change; restore a verified backup if a rollback needs the older schema.

Troubleshooting: check the container logs without sharing tokens or invoice data; verify both API origins reach the same backend, every migration is applied, Auth redirects match, public variables were rebuilt, and the service-role key is server only.
