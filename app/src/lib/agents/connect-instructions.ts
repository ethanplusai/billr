/**
 * Single source of truth for the per-client "how do I connect this thing"
 * steps. Both the in-app Agents → Connect panel and the public
 * /docs/connect page render from here, so the two can never drift, the same
 * way the MCP tool list lives in src/lib/mcp/tool-catalog.ts.
 *
 * Every client's steps were checked against the vendor's own documentation on
 * 2026-09-21. The page that was read is recorded in `source` on each client.
 * If you change a menu path or a command here, re-read the vendor page first
 * and update `source` and `verifiedOn`. Never write a step from memory.
 */

import { mcpUrl } from '@/lib/deployment'

/** A copyable command or configuration block attached to a step. */
export interface ConnectCode {
  /** Shown above the block, for example "TERMINAL" or ".cursor/mcp.json". */
  label: string
  text: string
}

export interface ConnectStep {
  title: string
  /** One or two sentences of context. Optional when the title says it all. */
  detail?: string
  code?: ConnectCode
}

/** The manual `billr_sk_` path, shown behind a disclosure under the steps. */
interface ConnectFallback {
  summary: string
  detail: string
  steps: ConnectStep[]
}

export interface ConnectClient {
  id: string
  /** Tab label. */
  name: string
  /** Basename of the mark under /public/agents. */
  mark: string
  /** Longer heading inside the tab. */
  title: string
  /** The "What you need" line. */
  requirements: string
  steps: ConnectStep[]
  /** The first thing to ask the agent once it is connected. */
  verify: string
  fallback?: ConnectFallback
  /** Vendor documentation page these steps were read from, when there is one. */
  source?: string
  verifiedOn: string
}

/** What the Billr consent screen asks for, quoted by both surfaces. */
export const CONSENT_SUMMARY =
  'Signing in shows a consent screen that asks which business the agent may work in and which permissions it gets, with read and write on by default and send, payments and delete optional. Every connection shows up under Agents → API Keys and can be revoked there at any time.'

/** Read-only prompt that proves the connection without writing anything. */
export const FIRST_PROMPT =
  'List my Billr clients and tell me what is still unbilled.'

const VERIFIED_ON = '2026-09-21'

export function connectClients(url: string = mcpUrl()): ConnectClient[] {
  return [
    {
      id: 'claude',
      name: 'Claude',
      mark: 'claude',
      title: 'Add Billr as a custom connector',
      requirements:
        'A Claude account on any plan. Free accounts can add one custom connector. On Team and Enterprise only an Owner can add the connector, after which each member connects for themselves.',
      steps: [
        {
          title: 'Open your connector list',
          detail:
            'In claude.ai or Claude Desktop, go to Customize, then Connectors. Team and Enterprise Owners add it from Organization settings, then Connectors.',
        },
        {
          title: 'Add a custom connector',
          detail:
            'Click the plus button, then "Add custom connector". Team and Enterprise Owners click "Add", hover "Custom" and select "Web".',
        },
        {
          title: 'Paste the Billr MCP URL',
          detail:
            'The URL is the only field you need. Leave Advanced settings empty: Billr registers Claude as a client on its own, so there is no client ID or secret to paste.',
          code: { label: 'MCP SERVER URL', text: url },
        },
        {
          title: 'Click Add, then Connect',
          detail:
            'Claude sends you to Billr to sign in and approve the connection. Pick the business and the permissions, then approve.',
        },
        {
          title: 'Switch Billr on in a chat',
          detail:
            'Use the plus button at the bottom of the chat, choose Connectors, and toggle Billr on for that conversation.',
        },
      ],
      verify: `Ask Claude: "${FIRST_PROMPT}" It reads only, so nothing is created or sent.`,
      source:
        'https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp',
      verifiedOn: VERIFIED_ON,
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      mark: 'claude',
      title: 'Add Billr from your terminal',
      requirements:
        'Claude Code installed, and a terminal open in any project directory.',
      steps: [
        {
          title: 'Add the server',
          detail:
            'Run this once. Add --scope user to make Billr available in every project instead of only this one.',
          code: {
            label: 'TERMINAL',
            text: `claude mcp add --transport http billr ${url}`,
          },
        },
        {
          title: 'Start Claude Code and run /mcp',
          detail:
            'Pick billr from the list and choose to authenticate. Claude Code opens Billr in your browser.',
          code: { label: 'IN CLAUDE CODE', text: '/mcp' },
        },
        {
          title: 'Approve in the browser',
          detail:
            'Sign in to Billr, choose the business and the permissions, and approve. Then go back to your terminal.',
        },
        {
          title: 'Check it is connected',
          detail: 'billr should be listed as connected.',
          code: { label: 'TERMINAL', text: 'claude mcp list' },
        },
      ],
      verify: `Ask Claude Code: "${FIRST_PROMPT}" It reads only, so nothing is created or sent.`,
      fallback: {
        summary: 'Use an API key instead',
        detail:
          'Create a key under Agents → API Keys, then pass it as a bearer token when you add the server. Replace YOUR_KEY with the key you copied.',
        steps: [
          {
            title: 'Add the server with a key',
            code: {
              label: 'TERMINAL',
              text: `claude mcp add --transport http billr ${url} --header "Authorization: Bearer YOUR_KEY"`,
            },
          },
        ],
      },
      source: 'https://code.claude.com/docs/en/mcp',
      verifiedOn: VERIFIED_ON,
    },
    {
      id: 'codex',
      name: 'Codex',
      mark: 'codex',
      title: 'Add Billr to the Codex CLI',
      requirements: 'The Codex CLI installed and signed in.',
      steps: [
        {
          title: 'Add the server',
          code: {
            label: 'TERMINAL',
            text: `codex mcp add billr --url ${url}`,
          },
        },
        {
          title: 'Sign in',
          detail:
            'Codex opens Billr in your browser. Choose the business and the permissions, then approve.',
          code: { label: 'TERMINAL', text: 'codex mcp login billr' },
        },
        {
          title: 'Check it is connected',
          detail:
            'billr should appear in the list. Inside the Codex TUI, /mcp shows the same thing.',
          code: { label: 'TERMINAL', text: 'codex mcp list' },
        },
      ],
      verify: `Ask Codex: "${FIRST_PROMPT}" It reads only, so nothing is created or sent.`,
      fallback: {
        summary: 'Use an API key instead',
        detail:
          'Create a key under Agents → API Keys and export it as BILLR_API_KEY in the shell that starts Codex, then add this table to ~/.codex/config.toml, or to .codex/config.toml for one project.',
        steps: [
          {
            title: 'Configure a bearer token',
            code: {
              label: '~/.codex/config.toml',
              text: `[mcp_servers.billr]\nurl = "${url}"\nbearer_token_env_var = "BILLR_API_KEY"`,
            },
          },
        ],
      },
      source: 'https://learn.chatgpt.com/docs/extend/mcp?surface=cli',
      verifiedOn: VERIFIED_ON,
    },
    {
      id: 'cursor',
      name: 'Cursor',
      mark: 'cursor',
      title: 'Add Billr to your Cursor config',
      requirements:
        'Cursor, and a project folder if you want Billr only in that project.',
      steps: [
        {
          title: 'Create the config file',
          detail:
            'Use .cursor/mcp.json in the project root for one project, or ~/.cursor/mcp.json for every project.',
        },
        {
          title: 'Paste the server entry',
          detail:
            'A url entry is all Cursor needs. Cursor registers itself with Billr automatically, so there is no client ID to fill in.',
          code: {
            label: '.cursor/mcp.json',
            text: `{\n  "mcpServers": {\n    "billr": {\n      "url": "${url}"\n    }\n  }\n}`,
          },
        },
        {
          title: 'Save the file and sign in',
          detail:
            'Billr appears in the MCP list on the Customize page. Cursor supports OAuth for servers that require it, so it opens Billr in your browser. Choose the business and the permissions, then approve.',
        },
      ],
      verify: `Ask Cursor: "${FIRST_PROMPT}" It reads only, so nothing is created or sent.`,
      fallback: {
        summary: 'Use an API key instead',
        detail:
          'Create a key under Agents → API Keys and set BILLR_API_KEY in the environment Cursor starts from, then send it as a header. Cursor reads ${env:NAME} in header values, so the key never sits in the file.',
        steps: [
          {
            title: 'Send the key as a header',
            code: {
              label: '.cursor/mcp.json',
              text: `{\n  "mcpServers": {\n    "billr": {\n      "url": "${url}",\n      "headers": {\n        "Authorization": "Bearer \${env:BILLR_API_KEY}"\n      }\n    }\n  }\n}`,
            },
          },
        ],
      },
      source: 'https://cursor.com/docs/context/mcp',
      verifiedOn: VERIFIED_ON,
    },
    {
      id: 'chatgpt',
      name: 'ChatGPT',
      mark: 'chatgpt',
      title: 'Connect Billr in developer mode',
      requirements:
        'A ChatGPT account with developer mode available. OpenAI documents the steps below but does not list which plans include developer mode, so check your own Settings first.',
      steps: [
        {
          title: 'Turn on developer mode',
          detail:
            'In ChatGPT, open Settings, then "Security and login", and turn on Developer mode.',
        },
        {
          title: 'Open the plugin list',
          detail: 'Go to ChatGPT Plugins and select the plus button.',
        },
        {
          title: 'Connect the Billr MCP URL',
          detail: 'Paste the URL and connect the server in developer mode.',
          code: { label: 'MCP SERVER URL', text: url },
        },
        {
          title: 'Sign in to Billr',
          detail:
            'ChatGPT runs an OAuth flow against Billr. Choose the business and the permissions, then approve. There is no API key option here: OAuth is the only way in.',
        },
      ],
      verify: `Ask ChatGPT: "${FIRST_PROMPT}" It reads only, so nothing is created or sent.`,
      source: 'https://developers.openai.com/api/docs/mcp',
      verifiedOn: VERIFIED_ON,
    },
    {
      id: 'other',
      name: 'Other / API key',
      mark: 'mcp',
      title: 'Connect any other MCP client',
      requirements:
        'Any client that can talk to a remote MCP server over streamable HTTP.',
      steps: [
        {
          title: 'Add a remote HTTP MCP server with this URL',
          detail:
            'If the client supports MCP authorization, that is everything it needs. It discovers the Billr sign-in page from the URL and asks you to approve a business and a set of permissions.',
          code: { label: 'MCP SERVER URL', text: url },
        },
        {
          title: 'Sign in when the client opens Billr',
          detail:
            'Choose the business and the permissions, then approve. The connection then shows up under Agents → API Keys.',
        },
        {
          title: 'If the client cannot sign in, use a key',
          detail:
            'Clients with no OAuth support can still connect with a bearer token. Open the panel below.',
        },
      ],
      verify: `Ask your agent: "${FIRST_PROMPT}" It reads only, so nothing is created or sent.`,
      fallback: {
        summary: 'Use an API key instead',
        detail:
          'Create a key under Agents → API Keys, copy it once, and give the client the URL plus an Authorization header. A wrong or revoked key gets a 401 rather than an empty list, so a bad key never looks like an empty account.',
        steps: [
          {
            title: 'URL and header',
            code: {
              label: 'MCP CONFIGURATION',
              text: `URL: ${url}\nAuthorization: Bearer YOUR_KEY`,
            },
          },
        ],
      },
      verifiedOn: VERIFIED_ON,
    },
  ]
}
