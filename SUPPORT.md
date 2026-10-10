# Support

## Where to ask

| You want to | Go to |
| --- | --- |
| Ask a question about running Billr | **GitHub Issues** on this repository; start the title with "Question:" |
| Report a reproducible bug | **GitHub Issues**, using the bug report form |
| Suggest a feature | **GitHub Issues**, using the feature request form |
| Report a vulnerability | Privately, through the **Security** tab. See [SECURITY.md](SECURITY.md) |

## Before you ask

Most setup questions are answered by [README.md](README.md), [docs/self-hosting.md](docs/self-hosting.md) and [docs/fresh-machine-test.md](docs/fresh-machine-test.md). If the answer is not there, say so: a question the documentation should have answered is a documentation bug.

When you ask, include:

- how you run Billr (local development, Docker, which host),
- the commit you are on,
- Node.js version and operating system,
- the exact command you ran and its output, with secrets removed,
- what you expected and what happened instead.

Never paste a service-role key, a Stripe secret, an API key, a database URL with a password, or a real invoice or client record. Reproduce with fictional data.

## What maintainers help with

- Bugs in this source, including the MCP server, the migrations, the agent toolkit and the plugins.
- Documentation that is wrong, missing or misleading.
- Questions about the intended behaviour of a feature or a tool contract.

## What is yours to run

The maintainers do not operate your installation and cannot see it:

- **Infrastructure:** Supabase or Postgres, containers, reverse proxies, TLS, DNS, storage and cost.
- **Third-party accounts:** your Stripe account, your Resend account and sending domain, your OAuth provider apps.
- **Your data:** backups, restores, retention and recovering from a deletion. There is no importer for historical invoices.
- **Your modifications:** a fork, a changed policy or an added service-role caller is supported by whoever made it.
- **Compliance:** tax treatment, invoice legality in your jurisdiction, data residency.

Support is best effort from a very small team, with no service level agreement.
