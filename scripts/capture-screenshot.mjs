/**
 * Gera as imagens do README: um PNG estatico ou um GIF animado do badge.
 *
 * O GIF mostra o badge acompanhando o consumo e trocando de modelo. Em TODOS os
 * quadros os valores sao neutralizados antes da captura, para o gasto real de
 * quem roda isto nunca virar imagem publica.
 *
 * Uso:
 *   node scripts/capture-screenshot.mjs <url-da-gui-com-token> [saida.png]
 *   node scripts/capture-screenshot.mjs <url-da-gui-com-token> [saida.gif] --gif
 *
 * Variaveis de ambiente:
 *   CHROME_PATH  caminho do navegador Chromium (se nao estiver nos locais usuais)
 *   DSH_SHARP    caminho do package.json do dsh, para achar o `sharp` emprestado
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const url = process.argv[2]
const querGif = process.argv.includes('--gif')
const posicional = process.argv.slice(3).find((arg) => !arg.startsWith('--'))
const output = posicional ?? join(PACKAGE_ROOT, 'docs', querGif ? 'badge.gif' : 'badge.png')
const DEBUG_PORT = 9363

if (url === undefined) {
  console.error('uso: node scripts/capture-screenshot.mjs <url-da-gui-com-token> [saida] [--gif]')
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

/**
 * Quadros do GIF. O seletor de modelo e o badge sao reescritos no DOM com estes
 * valores ANTES de cada captura — nada aqui vem do consumo real.
 */
const QUADROS = [
  { seletor: 'DeepSeek-V4.1-Flash', rotulo: 'V4.1-Flash', mes: 'US$ 0,16', sessao: 'US$ 0,04', delay: 1300 },
  { seletor: 'DeepSeek-V4.1-Flash', rotulo: 'V4.1-Flash', mes: 'US$ 0,16', sessao: 'US$ 0,05', delay: 700 },
  { seletor: 'DeepSeek-V4-Pro', rotulo: 'V4-Pro', mes: 'US$ 0,42', sessao: 'US$ 0,06', delay: 1600 },
  { seletor: 'DeepSeek-V4-Pro', rotulo: 'V4-Pro', mes: 'US$ 0,42', sessao: 'US$ 0,07', delay: 700 },
]

function resolveBrowser() {
  if (process.env.CHROME_PATH !== undefined && process.env.CHROME_PATH !== '') return process.env.CHROME_PATH
  const found = CANDIDATES.find((candidate) => existsSync(candidate))
  if (found === undefined) {
    console.error('nao encontrei um navegador Chromium. Defina CHROME_PATH.')
    process.exit(1)
  }
  return found
}

/** O `sharp` nao e dependencia do pacote; empresta o da instalacao do dsh. */
async function resolveSharp() {
  try {
    return (await import('sharp')).default
  } catch {
    /* segue para os candidatos */
  }
  const candidatos = [
    process.env.DSH_SHARP,
    process.env.APPDATA === undefined ? undefined : join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    '/usr/lib/node_modules/@deepseek-ai/dsh/package.json',
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
  ].filter((candidate) => typeof candidate === 'string' && existsSync(candidate))
  for (const anchor of candidatos) {
    try {
      return createRequire(anchor)('sharp')
    } catch {
      /* tenta o proximo */
    }
  }
  console.error('para o GIF eu preciso do sharp: rode `npm i -D sharp` ou defina DSH_SHARP com o caminho do package.json do dsh.')
  process.exit(1)
}

const profile = mkdtempSync(join(tmpdir(), 'dsh-shot-'))
const chrome = spawn(
  resolveBrowser(),
  [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${String(DEBUG_PORT)}`, `--user-data-dir=${profile}`,
    '--window-size=1440,760', '--hide-scrollbars', url,
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

/** Reescreve o seletor de modelo e o badge com valores de exemplo. */
const neutralizar = (quadro) => `(() => {
  const badge = document.querySelector('.dsh-cost-meter');
  if (badge === null) return null;
  const mes = badge.querySelector('.month');
  const sessao = badge.querySelector('.session');
  if (mes !== null) mes.innerHTML = '${quadro.rotulo} <b>${quadro.mes}</b> no mês';
  if (sessao !== null) sessao.textContent = '${quadro.sessao} na sessão';
  badge.setAttribute('title', 'Modelo selecionado: ${quadro.seletor}');

  const botao = document.querySelector('button[aria-label^="Select model"]');
  const rotulo = botao === null ? null : botao.querySelector('[class*="triggerLabel"]');
  if (rotulo !== null && rotulo !== undefined) rotulo.textContent = '${quadro.seletor}';
  return badge.textContent;
})()`

await send('Runtime.enable')
await send('Page.enable')
await wait(9000)
await evaluate(`(() => {
  const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').trim() === 'New Session');
  b?.click();
})()`)
await wait(8000)

// O recorte e calculado UMA vez: todos os quadros precisam ter o mesmo tamanho.
const recorte = await evaluate(`(() => {
  const badge = document.querySelector('.dsh-cost-meter');
  if (badge === null) return null;
  let barra = badge;
  for (let i = 0; i < 8 && barra.parentElement !== null; i += 1) {
    const r = barra.getBoundingClientRect();
    if (r.width >= 320 && r.height >= 28) break;
    barra = barra.parentElement;
  }
  const r = barra.getBoundingClientRect();
  const PAD = 14;
  const x = Math.max(0, r.left - PAD);
  const y = Math.max(0, r.top - PAD);
  return {
    x, y,
    width: Math.min(window.innerWidth - x, Math.max(360, r.width + PAD * 2)),
    height: Math.min(window.innerHeight - y, Math.max(48, r.height + PAD * 2)),
  };
})()`)

if (recorte === null) {
  console.error('o badge nao apareceu — confira se a GUI tem o plugin ativo')
  socket.close()
  chrome.kill()
  process.exit(1)
}
console.log(`recorte: ${String(Math.round(recorte.width))}x${String(Math.round(recorte.height))} em (${String(Math.round(recorte.x))}, ${String(Math.round(recorte.y))})`)

const quadros = querGif ? QUADROS : [QUADROS[0]]
const capturas = []
for (const [indice, quadro] of quadros.entries()) {
  const texto = await evaluate(neutralizar(quadro))
  if (texto === null) {
    console.error(`quadro ${String(indice)}: o badge sumiu no meio da captura`)
    socket.close()
    chrome.kill()
    process.exit(1)
  }
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { ...recorte, scale: 2 },
    captureBeyondViewport: false,
  })
  const data = shot.result?.data
  if (typeof data !== 'string' || data.length === 0) {
    console.error(`quadro ${String(indice)}: a captura falhou`)
    socket.close()
    chrome.kill()
    process.exit(1)
  }
  capturas.push(Buffer.from(data, 'base64'))
  console.log(`quadro ${String(indice)}: ${String(texto)}`)
}

mkdirSync(dirname(output), { recursive: true })

if (querGif) {
  const sharp = await resolveSharp()
  const gif = await sharp(capturas, { join: { animated: true } })
    .gif({ delay: QUADROS.map((quadro) => quadro.delay), loop: 0 })
    .toBuffer()
  writeFileSync(output, gif)
  const meta = await sharp(gif, { animated: true }).metadata()
  console.log(`GIF gravado: ${output} — ${String(meta.pages)} quadros, ${String(meta.width)}x${String(meta.pageHeight)}, ${String(Math.round(gif.length / 1024))} KB`)
} else {
  writeFileSync(output, capturas[0])
  console.log(`PNG gravado: ${output}`)
}

socket.close()
chrome.kill()
setTimeout(() => process.exit(0), 300)
