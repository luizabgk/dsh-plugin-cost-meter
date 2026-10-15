/**
 * Gera a imagem do badge para o README.
 *
 * Sobe um Chrome headless, abre a GUI, cria uma sessao e captura a barra do
 * composer — NEUTRALIZANDO os valores antes do clique, para o gasto real de
 * quem roda isto nunca virar imagem publica.
 *
 * Uso:  node scripts/capture-screenshot.mjs <url-da-gui-com-token> [saida.png]
 *       CHROME_PATH=/caminho/do/chrome node scripts/capture-screenshot.mjs <url>
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const url = process.argv[2]
const output = process.argv[3] ?? join(PACKAGE_ROOT, 'docs', 'badge.png')
const DEBUG_PORT = 9363

if (url === undefined) {
  console.error('uso: node scripts/capture-screenshot.mjs <url-da-gui-com-token> [saida.png]')
  process.exit(1)
}

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

/** Valores ilustrativos — os mesmos do exemplo no README. */
const EXEMPLO = {
  mes: 'US$ 0,16',
  sessao: 'US$ 0,04',
  tooltip: [
    'Modelo selecionado: V4.1-Flash',
    'Mes 2026-10: US$ 0,16',
    'Esta sessao: US$ 0,04',
    'Modelos desta sessao: DeepSeek-V4.1-Flash US$ 0,16',
    'Sessao: session-exemplo',
    'Precos: deepseek-docs',
  ].join('\\n'),
}

function resolveBrowser() {
  if (process.env.CHROME_PATH !== undefined && process.env.CHROME_PATH !== '') return process.env.CHROME_PATH
  const found = CANDIDATES.find((candidate) => existsSync(candidate))
  if (found === undefined) {
    console.error('nao encontrei um navegador Chromium. Defina CHROME_PATH.')
    process.exit(1)
  }
  return found
}

const profile = mkdtempSync(join(tmpdir(), 'dsh-shot-'))
const chrome = spawn(
  resolveBrowser(),
  [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${String(DEBUG_PORT)}`, `--user-data-dir=${profile}`,
    '--window-size=1440,760', url,
  ],
  { stdio: 'ignore' },
)

async function target() {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${String(DEBUG_PORT)}/json/list`)).json()
      const page = list.find((entry) => entry.type === 'page' && typeof entry.webSocketDebuggerUrl === 'string')
      if (page !== undefined) return page
    } catch {
      /* subindo */
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('sem alvo de pagina')
}

const page = await target()
const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 1
const pend = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined && pend.has(message.id)) {
    pend.get(message.id)(message)
    pend.delete(message.id)
  }
})
const send = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++
    const timer = setTimeout(() => {
      pend.delete(id)
      resolve({ result: {} })
    }, 20000)
    pend.set(id, (message) => {
      clearTimeout(timer)
      resolve(message)
    })
    socket.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return result.result?.result?.value
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

await send('Runtime.enable')
await send('Page.enable')
await wait(9000)
await evaluate(`(() => {
  const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').trim() === 'New Session');
  b?.click();
})()`)
await wait(8000)

// Neutraliza os valores e devolve o retangulo a capturar, tudo numa passada só.
const alvo = await evaluate(`(() => {
  const badge = document.querySelector('.dsh-cost-meter');
  if (badge === null) return null;
  const mes = badge.querySelector('.month');
  const sessao = badge.querySelector('.session');
  if (mes !== null) mes.innerHTML = 'V4.1-Flash <b>${EXEMPLO.mes}</b> no mês';
  if (sessao !== null) sessao.textContent = '${EXEMPLO.sessao} na sessão';
  badge.setAttribute('title', '${EXEMPLO.tooltip}');

  // Recorte: sobe do badge ate um ancestral com CAIXA de verdade. Varios
  // wrappers de slot usam display:contents, cujo getBoundingClientRect()
  // devolve zeros — foi o que produziu um recorte 28x28 na primeira tentativa.
  let barra = badge;
  for (let i = 0; i < 8 && barra.parentElement !== null; i += 1) {
    const r = barra.getBoundingClientRect();
    if (r.width >= 320 && r.height >= 28) break;
    barra = barra.parentElement;
  }
  const r = barra.getBoundingClientRect();
  const PAD = 14;
  return {
    x: Math.max(0, r.left - PAD),
    y: Math.max(0, r.top - PAD),
    width: Math.min(window.innerWidth - Math.max(0, r.left - PAD), Math.max(360, r.width + PAD * 2)),
    height: Math.min(window.innerHeight - Math.max(0, r.top - PAD), Math.max(48, r.height + PAD * 2)),
    classe: String(barra.className).slice(0, 60),
    badgeTexto: badge.textContent,
  };
})()`)

if (alvo === null) {
  console.error('o badge nao apareceu — confira se a GUI tem o plugin ativo')
  socket.close()
  chrome.kill()
  process.exit(1)
}
console.log(`recorte: ${String(Math.round(alvo.width))}x${String(Math.round(alvo.height))} em (${String(Math.round(alvo.x))}, ${String(Math.round(alvo.y))})`)
console.log(`badge neutralizado: ${String(alvo.badgeTexto)}`)

const shot = await send('Page.captureScreenshot', {
  format: 'png',
  clip: { x: alvo.x, y: alvo.y, width: alvo.width, height: alvo.height, scale: 2 },
  captureBeyondViewport: false,
})

const data = shot.result?.data
if (typeof data !== 'string' || data.length === 0) {
  console.error('a captura falhou')
  socket.close()
  chrome.kill()
  process.exit(1)
}
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, Buffer.from(data, 'base64'))
console.log(`imagem gravada: ${output}`)

socket.close()
chrome.kill()
setTimeout(() => process.exit(0), 300)
