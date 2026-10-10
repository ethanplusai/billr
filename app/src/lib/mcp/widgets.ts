import type { McpServer } from '@modelcontextprotocol/server'
import { WIDGET_TOOLS, type WidgetTool } from './openai-apps'

/**
 * Billr cards for MCP Apps hosts (ChatGPT, and Codex inside the ChatGPT desktop
 * app where it renders them).
 *
 * Each card is one self-contained HTML document: inline CSS and plain
 * JavaScript, no bundler, no network access, so the content security policy
 * can stay empty. The host hands the card the tool's `structuredContent`; the
 * card never fetches Billr data on its own.
 *
 * Buttons that change anything (send, convert, create an invoice) do not call
 * Billr tools directly. They post a user message, so the model runs the tool
 * the normal way and the host's own confirmation for consequential actions
 * still applies. The only direct action is opening a link.
 *
 * Bridge: MCP Apps JSON-RPC over postMessage (ui/initialize,
 * ui/notifications/tool-result, ui/message, ui/open-link), with the ChatGPT
 * `window.openai` globals as a fallback. Spec read 2026-10-01 from
 * https://developers.openai.com/plugins/build/chatgpt-ui.md
 */

export const WIDGET_MIME_TYPE = 'text/html;profile=mcp-app'

const VIEWS: Record<WidgetTool, string> = {
  get_invoice: 'invoice',
  get_estimate: 'estimate',
  revenue_summary: 'revenue',
  list_ready_to_bill: 'ready',
}

const CSS = `
:root{--bg:#fff;--fg:#18181b;--muted:#71717a;--line:#e7e9ee;--soft:#f6f7f9;--primary:#2563eb;--primary-fg:#fff;--ok:#15803d;--ok-bg:#dcfce7;--warn:#b45309;--warn-bg:#fef3c7;--bad:#b91c1c;--bad-bg:#fee2e2;color-scheme:light}
:root.dark{--bg:#18181b;--fg:#fafafa;--muted:#a1a1aa;--line:#2e2e33;--soft:#232327;--primary:#3b82f6;--ok:#4ade80;--ok-bg:#14532d;--warn:#fbbf24;--warn-bg:#451a03;--bad:#f87171;--bad-bg:#450a0a;color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;background:transparent}
body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--fg)}
.card{background:var(--bg);border:1px solid var(--line);border-radius:14px;padding:16px 18px}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.brand{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:12px;font-weight:500}
.brand i{display:inline-block;width:14px;height:14px;border-radius:4px;background:var(--primary)}
h1{font-size:16px;font-weight:600;margin:4px 0 0;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:13px;margin-top:2px}
.amount{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.amount small{display:block;font-size:12px;font-weight:400;color:var(--muted)}
.pill{display:inline-block;border-radius:999px;padding:1px 8px;font-size:11px;font-weight:600;background:var(--soft);color:var(--muted);text-transform:capitalize}
.pill.ok{background:var(--ok-bg);color:var(--ok)}.pill.warn{background:var(--warn-bg);color:var(--warn)}.pill.bad{background:var(--bad-bg);color:var(--bad)}
table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}
th{color:var(--muted);font-weight:500;font-size:11px;text-align:left;padding:6px 0;border-bottom:1px solid var(--line)}
td{padding:7px 0;border-bottom:1px solid var(--line);vertical-align:top}
th.r,td.r{text-align:right;padding-left:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.totals{margin-top:8px;display:grid;gap:2px;justify-content:end;font-size:13px}
.totals div{display:flex;gap:24px;justify-content:space-between}
.totals .grand{font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-top:12px}
.stat{background:var(--soft);border-radius:10px;padding:10px 12px}
.stat b{display:block;font-size:17px;font-variant-numeric:tabular-nums}
.stat span{color:var(--muted);font-size:12px}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
button{font:inherit;font-size:13px;font-weight:500;border-radius:8px;padding:6px 12px;cursor:pointer;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
button.primary{background:var(--primary);border-color:var(--primary);color:var(--primary-fg)}
button:disabled{opacity:.55;cursor:default}
.row-action{padding:3px 9px;font-size:12px}
.empty{color:var(--muted);padding:6px 0}
.note{color:var(--muted);font-size:12px;margin-top:10px}
`

const SCRIPT = String.raw`
(function(){
  var VIEW = document.documentElement.getAttribute('data-view');
  var root = document.getElementById('root');
  var nextId = 1, pending = {};

  function rpc(method, params){
    var id = nextId++;
    return new Promise(function(resolve){
      pending[id] = resolve;
      window.parent.postMessage({ jsonrpc:'2.0', id:id, method:method, params:params||{} }, '*');
      setTimeout(function(){ if(pending[id]){ delete pending[id]; resolve(null); } }, 4000);
    });
  }
  function notify(method, params){ window.parent.postMessage({ jsonrpc:'2.0', method:method, params:params||{} }, '*'); }

  function esc(v){ return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function money(n, cur){ if(n==null||isNaN(n)) return ''; try { return new Intl.NumberFormat(document.documentElement.lang||'en-US',{style:'currency',currency:cur||'USD'}).format(n); } catch(e){ return Number(n).toFixed(2)+' '+(cur||''); } }
  function day(iso){ if(!iso) return ''; var d=new Date(iso+(String(iso).length===10?'T00:00:00':'')); return isNaN(d)?esc(iso):d.toLocaleDateString(document.documentElement.lang||'en-US',{month:'short',day:'numeric',year:'numeric'}); }
  function pill(status, overdue){
    var s = overdue ? 'overdue' : String(status||'');
    var cls = /paid|accepted|converted|invoiced/.test(s) ? 'ok' : /overdue|declined|expired|void/.test(s) ? 'bad' : /sent|viewed|partial|ready/.test(s) ? 'warn' : '';
    return '<span class="pill '+cls+'">'+esc(s.replace(/_/g,' '))+'</span>';
  }
  var BRAND = '<div class="brand"><i></i>Billr</div>';

  function say(text){
    return rpc('ui/message', { role:'user', content:[{ type:'text', text:text }] }).then(function(res){
      if(res===null && window.openai && window.openai.sendFollowUpMessage) return window.openai.sendFollowUpMessage({ prompt:text });
    });
  }
  function open(url){
    rpc('ui/open-link', { url:url }).then(function(res){
      if(res===null){
        if(window.openai && window.openai.openExternal) window.openai.openExternal({ href:url });
        else window.open(url, '_blank', 'noopener');
      }
    });
  }

  function lineTable(items, cur){
    if(!items||!items.length) return '';
    var rows = items.map(function(li){ return '<tr><td>'+esc(li.description)+'</td><td class="r">'+esc(li.quantity)+'</td><td class="r">'+money(li.rate,cur)+'</td><td class="r">'+money(li.amount,cur)+'</td></tr>'; }).join('');
    return '<table><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead><tbody>'+rows+'</tbody></table>';
  }

  var RENDER = {
    invoice: function(d){
      var inv = d.invoice; if(!inv) return null;
      var cur = inv.currency, client = inv.client && inv.client.name;
      var html = '<div class="card"><div class="top"><div>'+BRAND+'<h1>Invoice '+esc(inv.invoice_number)+' '+pill(inv.status, inv.is_overdue)+'</h1>'
        +'<div class="sub">'+esc(client||'No client')+(inv.due_date?' &middot; due '+day(inv.due_date):'')+'</div></div>'
        +'<div class="amount">'+money(inv.balance_due,cur)+'<small>balance due of '+money(inv.total,cur)+'</small></div></div>'
        + lineTable(inv.line_items, cur)
        +'<div class="totals">'
        +(inv.tax_amount?'<div><span>Tax</span><span>'+money(inv.tax_amount,cur)+'</span></div>':'')
        +'<div class="grand"><span>Total</span><span>'+money(inv.total,cur)+'</span></div>'
        +(inv.amount_paid?'<div><span>Paid</span><span>'+money(inv.amount_paid,cur)+'</span></div>':'')
        +'</div><div class="actions">';
      if(inv.status==='draft') html += '<button class="primary" data-say="Send invoice '+esc(inv.invoice_number)+' to '+esc(client||'the client')+'.">Send to client</button>';
      else if(inv.balance_due>0) html += '<button class="primary" data-say="Send a payment reminder for invoice '+esc(inv.invoice_number)+'.">Send reminder</button>';
      if(inv.balance_due>0 && inv.status!=='draft') html += '<button data-say="Record a payment on invoice '+esc(inv.invoice_number)+'.">Record payment</button>';
      if(inv.public_url) html += '<button data-open="'+esc(inv.public_url)+'">Client view</button>';
      if(inv.app_url) html += '<button data-open="'+esc(inv.app_url)+'">Open in Billr</button>';
      return html+'</div></div>';
    },
    estimate: function(d){
      var est = d.estimate; if(!est) return null;
      var cur = est.currency;
      var html = '<div class="card"><div class="top"><div>'+BRAND+'<h1>Estimate '+esc(est.estimate_number)+' '+pill(est.status)+'</h1>'
        +'<div class="sub">'+esc(est.client_name||'No client')+(est.expiry_date?' &middot; valid until '+day(est.expiry_date):'')+'</div></div>'
        +'<div class="amount">'+money(est.total,cur)+'<small>total</small></div></div>'
        + lineTable(est.line_items, cur) +'<div class="actions">';
      if(est.status==='draft') html += '<button class="primary" data-say="Send estimate '+esc(est.estimate_number)+' to '+esc(est.client_name||'the client')+'.">Send to client</button>';
      if(!est.converted_invoice_id && est.status!=='declined' && est.status!=='draft') html += '<button class="primary" data-say="Convert estimate '+esc(est.estimate_number)+' into an invoice.">Convert to invoice</button>';
      if(d.public_url) html += '<button data-open="'+esc(d.public_url)+'">Client view</button>';
      if(d.app_url) html += '<button data-open="'+esc(d.app_url)+'">Open in Billr</button>';
      return html+'</div></div>';
    },
    revenue: function(d){
      if(!d.summary) return null;
      var p = String(d.period||'revenue').replace(/_/g,' ');
      var label = 'Revenue, ' + p;
      var html = '<div class="card">'+BRAND+'<h1>'+esc(label)+'</h1>';
      if(d.currency){
        html += '<div class="grid">'
          +'<div class="stat"><b>'+money(d.invoiced_total,d.currency)+'</b><span>Invoiced</span></div>'
          +'<div class="stat"><b>'+money(d.paid_total,d.currency)+'</b><span>Paid</span></div>'
          +'<div class="stat"><b>'+money(d.outstanding_total,d.currency)+'</b><span>Outstanding</span></div>'
          +'<div class="stat"><b>'+money(d.overdue_total,d.currency)+'</b><span>Overdue</span></div></div>';
        if(d.top_clients&&d.top_clients.length){
          html += '<table><thead><tr><th>Top clients</th><th class="r">Invoiced</th></tr></thead><tbody>'
            + d.top_clients.map(function(c){ return '<tr><td>'+esc(c.name)+'</td><td class="r">'+money(c.invoiced,d.currency)+'</td></tr>'; }).join('')+'</tbody></table>';
        }
      } else {
        html += '<div class="sub">'+esc(d.summary)+'</div>';
      }
      if(d.overdue_total>0) html += '<div class="actions"><button class="primary" data-say="List my overdue invoices.">See overdue invoices</button></div>';
      return html+'</div>';
    },
    ready: function(d){
      var entries = d.entries||[];
      var html = '<div class="card">'+BRAND+'<h1>Ready to bill</h1><div class="sub">'+esc(entries.length)+' '+(entries.length===1?'entry':'entries')+(d.overdue_count?' &middot; '+esc(d.overdue_count)+' past their date':'')+'</div>';
      if(!entries.length) return html+'<div class="empty">Nothing is waiting to be invoiced.</div></div>';
      html += '<table><thead><tr><th>Client and work</th><th class="r">Amount</th><th class="r"></th></tr></thead><tbody>'
        + entries.map(function(e){
          return '<tr><td><b>'+esc(e.client_name||'Unknown client')+'</b><div class="sub">'+esc(e.engagement_name||'')+' &middot; '+esc(e.label)+(e.due_on?' &middot; '+day(e.due_on):'')+(e.overdue_on_date?' '+pill('overdue'):'')+'</div></td>'
            +'<td class="r">'+money(e.amount,e.currency)+'</td>'
            +'<td class="r"><button class="row-action" data-say="Create a draft invoice for '+esc(e.client_name||'this client')+' billing the engagement entry '+esc(e.entry_id)+' ('+esc(e.label)+').">Invoice</button></td></tr>';
        }).join('')+'</tbody></table>';
      if(entries.length>1) html += '<div class="actions"><button class="primary" data-say="Create draft invoices for everything that is ready to bill, one per client.">Draft invoices for all</button></div>';
      return html+'<div class="note">Invoices are created as drafts. Nothing is sent until you say so.</div></div>';
    }
  };

  var last = null;
  function render(data){
    if(!data||typeof data!=='object') return;
    last = data;
    var html = RENDER[VIEW] && RENDER[VIEW](data);
    root.innerHTML = html || '<div class="card"><div class="empty">'+esc(data.summary||'Nothing to show.')+'</div></div>';
    notify('ui/notifications/size-changed', { height: Math.ceil(root.getBoundingClientRect().height) });
  }

  root.addEventListener('click', function(ev){
    var b = ev.target.closest('button'); if(!b) return;
    if(b.dataset.open) return open(b.dataset.open);
    if(b.dataset.say){ b.disabled = true; say(b.dataset.say).then(function(){ setTimeout(function(){ b.disabled=false; }, 1500); }); }
  });

  function applyTheme(ctx){
    var theme = ctx && (ctx.theme || (ctx.hostContext && ctx.hostContext.theme));
    if(!theme && window.openai) theme = window.openai.theme;
    document.documentElement.classList.toggle('dark', theme==='dark');
  }

  window.addEventListener('message', function(ev){
    var m = ev.data; if(!m||m.jsonrpc!=='2.0') return;
    if(m.id!=null && pending[m.id]){ var r = pending[m.id]; delete pending[m.id]; r(m.result!==undefined?m.result:(m.error?{error:m.error}:{})); return; }
    if(m.method==='ui/notifications/tool-result') render(m.params && (m.params.structuredContent || m.params));
    if(m.method==='ui/notifications/host-context-changed') applyTheme(m.params);
  });
  window.addEventListener('openai:set_globals', function(){ applyTheme(); if(window.openai && window.openai.toolOutput) render(window.openai.toolOutput); });

  rpc('ui/initialize', { protocolVersion:'2026-01-26', appInfo:{ name:'billr', version:'1.0.0' }, appCapabilities:{} }).then(function(res){
    applyTheme(res && res.hostContext);
    notify('ui/notifications/initialized');
  });
  applyTheme();
  if(window.openai && window.openai.toolOutput) render(window.openai.toolOutput);
  else root.innerHTML = '<div class="card"><div class="empty">Loading from Billr...</div></div>';
})();
`

export function widgetHtml(tool: WidgetTool): string {
  return `<!doctype html><html lang="en" data-view="${VIEWS[tool]}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${CSS}</style></head><body><div id="root"></div><script>${SCRIPT}</script></body></html>`
}

/** Registers one ui:// resource per card. Called once per MCP request. */
export function registerBillrWidgets(server: McpServer) {
  for (const tool of Object.keys(WIDGET_TOOLS) as WidgetTool[]) {
    const uri = WIDGET_TOOLS[tool]
    server.registerResource(
      `billr-${VIEWS[tool]}-card`,
      uri,
      { title: `Billr ${VIEWS[tool]} card`, mimeType: WIDGET_MIME_TYPE },
      async () => ({
        contents: [
          {
            uri,
            mimeType: WIDGET_MIME_TYPE,
            text: widgetHtml(tool),
            _meta: {
              ui: {
                prefersBorder: false,
                // The card reads nothing from the network and loads no
                // assets, so every allowlist stays empty.
                csp: { connectDomains: [], resourceDomains: [], frameDomains: [] },
              },
              'openai/widgetDescription':
                'A Billr card showing the result. Its buttons ask you, in a user message, to run the matching Billr tool.',
              'openai/widgetPrefersBorder': false,
            },
          },
        ],
      }),
    )
  }
}
