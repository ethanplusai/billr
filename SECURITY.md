# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| Latest commit on `main` | Yes. Fixes land here. |
| Older commits and forks | No. Update to the latest `main`. |

Updating means pulling the latest source and applying the migrations you do not have yet. See [docs/self-hosting.md](docs/self-hosting.md).

## Reporting a vulnerability

Report privately through GitHub: open this repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue, a pull request or a discussion for a security problem.

Include:

- the commit you are running,
- a minimal reproduction using **fictional data only**,
- the impact you believe it has.

Do not post credentials, invoices, customer details or exploit instructions in public.

## What to expect

- **Acknowledgement within 3 business days.**
- **An initial assessment within 10 business days**, saying whether the report is accepted, how severe it is, and what happens next.
- **Updates at least every 14 days** while the report is open.
- Credit in [CHANGELOG.md](CHANGELOG.md) when the fix ships, unless you ask to stay anonymous.

Billr is maintained by a very small team. These are commitments about answering you, not about how fast a fix can be engineered.

## Scope

**In scope**

- The application source in this repository, including the MCP server, the OAuth endpoints, the API key model and the database migrations.
- Tenant isolation problems: reading, writing or inferring another business's data.
- Authentication and authorization bypasses, including an API key acting beyond its permissions or its business scope, and getting past closed sign-up.
- Leaks through the public invoice and estimate pages, which anyone holding the link can reach.
- The agent toolkit in `packages/agent-kit` and the plugin packs in `plugins`.

**Out of scope**

- An installation someone else operates. Report it to that operator.
- Misconfiguration of your own deployment: exposed database ports, a service-role key in a browser bundle, a development Supabase stack on the public internet, missing TLS.
- The browser anon or publishable key being visible. It is public by design; row-level security and server-side checks enforce access.
- Denial of service through volume, social engineering, physical access, and problems in third-party services (Supabase, Stripe, Resend, a hosting provider) not caused by Billr's code.
- Scanner output with no demonstrated impact.

## Your installation

You hold your installation's keys, apply its upgrades and own its data. Keep Supabase service-role keys, Stripe secrets, email credentials and backups private. Run the latest `main` with every migration applied, serve it over HTTPS, restrict database and admin ports, and test your backups. Nothing in Billr reports to anyone else.

## No bounty

There is no bug bounty and no payment for reports. What we offer is a real answer, a fix, and public credit if you want it.
