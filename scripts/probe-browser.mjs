/**
 * Verifica o badge num navegador real via DevTools Protocol.
 *
 * Uso:  node scripts/probe-browser.mjs <url-da-gui-com-token>
 *       CHROME_PATH=/caminho/do/chrome node scripts/probe-browser.mjs <url>
 *
 * Abre a GUI num navegador Chromium headless, clica em "New Session" e confere
 * se o elemento `.dsh-cost-meter` aparece no slot `conversation.input.right`.
 */
const url = process.argv[2]
const port = 9361
const { spawn } = await import('node:child_process')
const { mkdtempSync } = await import('node:fs')
const { existsSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

if (url === undefined) {
  console.error('uso: node scripts/probe-browser.mjs <url>')
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

const profile = mkdtempSync(join(tmpdir(), 'dsh-probe-'))
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
if (page === null) {
  console.error('sem alvo de pagina')
  chrome.kill()
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})
let nextId = 1
const pend = new Map()
const exceptions = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push(String(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text ?? 'excecao'))
  }
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
await new Promise((r) => setTimeout(r, 9000))
await evalJs(`(() => {
  const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').trim() === 'New Session');
  b?.click();
})()`)
await new Promise((r) => setTimeout(r, 8000))

const probe = await evalJs(`(() => {
  const right = document.querySelector('[data-slot="conversation.input.right"]');
  return {
    badge: document.querySelector('.dsh-cost-meter')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
    title: document.querySelector('.dsh-cost-meter')?.getAttribute('title') ?? null,
    rightChildren: right?.children?.length ?? -1,
  };
})()`)
console.log(JSON.stringify(probe, null, 2))
console.log(`excecoes: ${exceptions.length === 0 ? 'nenhuma' : exceptions.join(' | ')}`)

const ok = probe?.badge !== null && probe?.badge !== undefined
ws.close()
chrome.kill()
setTimeout(() => process.exit(ok ? 0 : 2), 300)
