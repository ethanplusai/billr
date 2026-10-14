# Billr for Grok Bot and Grok

## Grok Bot

Grok Bot is a distinct product with plugins and skills. Billr's package for
it is `../cursor/`: the Cursor marketplace manifest, generated billing skill,
logo and hosted OAuth MCP server. Follow that directory's README for setup
and publishing. The endpoint is `https://mcp.billr.cc`.

Before marketplace publication, test a custom MCP connection by asking Grok
Bot to add that endpoint, then approve only the intended business and scopes
on Billr's sign-in page. Do not paste passwords or keys into chat.

## Grok web and the xAI API

These are separate integration surfaces. For Grok web, use its custom MCP
connector flow with the same hosted URL. For the xAI API, use a remote MCP
tool and a narrowly scoped Billr bearer key loaded from a secret environment
variable. Never embed credentials in a package. API integration is not a
Grok Bot marketplace listing.

Sources: https://cursor.com/help/grok-bot/connect-plugins,
https://docs.x.ai/grok/connectors,
https://docs.x.ai/developers/tools/remote-mcp.
