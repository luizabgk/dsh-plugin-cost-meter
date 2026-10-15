/**
 * Inspeciona no DOM real como a sessao ativa e identificada, e o que o
 * seletor do badge encontra.
 *
 * Uso:  node scripts/inspect-dom.mjs <url-da-gui-com-token>
 *       CHROME_PATH=/caminho/do/chrome node scripts/inspect-dom.mjs <url>
 */
const url = process.argv[2]
const port = 9362
const { spawn } = await import('node:child_process')
const { mkdtempSync, existsSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

if (url === undefined) {
  console.error('uso: node scripts/inspect-dom.mjs <url>')
  process.exit(1)
}

/** Candidatos por plataforma; CHROME_PATH tem prioridade. */
const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

function resolveBrowser() {
  if (process.env.CHROME_PATH !== undefined && process.env.CHROME_PATH !== '') return process.env.CHROME_PATH
  const found = CANDIDATES.find((candidate) => existsSync(candidate))
  if (found === undefined) {
    console.error('nao encontrei um navegador Chromium. Defina CHROME_PATH com o caminho do executavel.')
    process.exit(1)
  }
  return found
}

const profile = mkdtempSync(join(tmpdir(), 'dsh-dom-'))
const chrome = spawn(
  resolveBrowser(),
  [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${String(port)}`, `--user-data-dir=${profile}`,
    '--window-size=1440,900', url,
  ],
  { stdio: 'ignore' },
)

const deadline = Date.now() + 30000
let page = null
while (Date.now() < deadline && page === null) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()
    page = list.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string') ?? null
  } catch {}
  if (page === null) await new Promise((r) => setTimeout(r, 500))
}
if (page === null) { console.error('sem alvo'); chrome.kill(); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})
let nextId = 1
const pend = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
})
const send = (method, params) =>
  new Promise((res) => {
    const id = nextId++
    const timer = setTimeout(() => { pend.delete(id); res({ result: { result: { value: `TIMEOUT ${method}` } } }) }, 15000)
    pend.set(id, (m) => { clearTimeout(timer); res(m) })
    ws.send(JSON.stringify({ id, method, params }))
  })
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  return r.result?.result?.value
}

await send('Runtime.enable')
// Clica em New Session para o composer existir e o badge montar.
await evalJs(`(() => {
  const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').trim() === 'New Session');
  b?.click();
})()`)
await new Promise((r) => setTimeout(r, 12000))

const probe = await evalJs(`(() => {
  const out = {};
  out.dataSessionId = Array.from(document.querySelectorAll('[data-session-id]')).slice(0, 5).map(e => e.getAttribute('data-session-id'));
  out.ariaCurrent = Array.from(document.querySelectorAll('[aria-current]')).slice(0, 5).map(e => e.getAttribute('aria-current') + '|' + (e.getAttribute('data-session-id') ?? e.tagName));
  out.seletorAtualDoBadge = document.querySelector('[data-session-id][data-active="true"], [aria-current="true"][data-session-id]')?.getAttribute('data-session-id') ?? null;
  // Todo atributo que contenha um pedaco de id de sessao conhecido
  const known = '4fd06464';
  const hits = [];
  for (const el of document.querySelectorAll('*')) {
    for (const attr of el.attributes ?? []) {
      if (String(attr.value).includes(known)) {
        hits.push(el.tagName + '[' + attr.name + '=' + String(attr.value).slice(0, 60) + ']');
        if (hits.length > 8) break;
      }
    }
    if (hits.length > 8) break;
  }
  out.atributosComIdConhecido = hits;
  out.sidebarHtml = (document.querySelector('[data-slot="sidebar"]')?.innerHTML ?? '').slice(0, 600);
  return out;
})()`)
console.log(JSON.stringify(probe, null, 2))
ws.close()
chrome.kill()
setTimeout(() => process.exit(0), 300)
