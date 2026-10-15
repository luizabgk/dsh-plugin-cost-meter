/**
 * Leitura da tabela de precos da DeepSeek para o plugin cost-meter.
 *
 * A tabela oficial vive em https://api-docs.deepseek.com/quick_start/pricing e
 * muda sem aviso; este modulo baixa a pagina, converte a tabela em JSON e grava
 * o resultado em price-cache.json, caindo para os valores embutidos em
 * price-defaults.json quando a rede falha.
 *
 * E Node puro, sem nenhuma API interna do DSH, o que tambem permite confere-lo
 * por um script fora da GUI (scripts/check-pricing.mjs).
 *
 * Os arquivos JSON de preco ficam na raiz do pacote; este modulo, em lib/.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const PRICING_URL = 'https://api-docs.deepseek.com/quick_start/pricing'
export const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

const HERE = dirname(fileURLToPath(import.meta.url))
export const PACKAGE_ROOT = dirname(HERE)
export const DEFAULTS_PATH = join(PACKAGE_ROOT, 'price-defaults.json')
export const CACHE_PATH = join(PACKAGE_ROOT, 'price-cache.json')

/** Linhas de preco publicadas, na ordem em que aparecem na tabela. */
const ROWS = [
  ['cacheHit', /CACHE\s*HIT/i],
  ['cacheMiss', /CACHE\s*MISS/i],
  ['output', /OUTPUT\s*TOKENS/i],
]

/** Modelos na ordem das colunas de valor da tabela oficial. */
const COLUMNS = [
  { id: 'deepseek-flash', match: /flash/i },
  { id: 'deepseek-v4-pro', match: /\bpro\b/i },
]

const dollars = (value) => [...String(value).matchAll(/\$\s*([0-9]+(?:\.[0-9]+)?)/g)].map((m) => Number(m[1]))

/** Texto de uma celula: tags viram espaco, entidades resolvidas. */
function cellText(html) {
  return String(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Linhas da tabela como arrays de celulas; vazio quando nao ha <table>. */
export function parseTableRows(html) {
  return String(html)
    .split(/<tr[^>]*>/i)
    .slice(1)
    .map((chunk) =>
      chunk
        .split(/<\/tr>/i)[0]
        .split(/<t[dh][^>]*>/i)
        .slice(1)
        .map((cell) => cellText(cell.split(/<\/t[dh]>/i)[0])),
    )
    .filter((cells) => cells.length > 0)
}

/**
 * Extrai as tarifas por 1M tokens da pagina oficial.
 *
 * A tabela usa celulas com rowspan — a faixa (OFF-PEAK/PEAK) aparece so na
 * primeira linha do par e o rotulo (1M INPUT TOKENS...) so na primeira linha do
 * grupo —, entao o parser rastreia o rotulo e a faixa vigentes e casa cada valor
 * pela POSICAO da coluna que o contem. Assim, uma celula faltante desloca a
 * coluna em vez de trocar precos entre modelos.
 *
 * @param html - conteudo da pagina.
 * @returns tarifas por modelo, ou null quando a tabela nao foi reconhecida.
 */
export function parsePricing(html) {
  const rows = parseTableRows(html)
  if (rows.length === 0) return null

  const header = rows.find((cells) => cells.some((cell) => /^MODEL$/i.test(cell)))
  if (header === undefined) return null

  // A linha de cabecalho lista os modelos nas colunas de valor; as linhas de
  // preco repetem essas colunas a partir da ultima celula de texto.
  const order = []
  header.forEach((label) => {
    if (/^MODEL$/i.test(label)) return
    const found = COLUMNS.find((column) => column.match.test(label))
    if (found !== undefined && !order.includes(found.id)) order.push(found.id)
  })
  if (order.length === 0) return null

  const table = {}
  order.forEach((id) => {
    table[id] = { cacheHit: {}, cacheMiss: {}, output: {} }
  })

  let row = null
  let tier = null

  for (const cells of rows) {
    const joined = cells.join(' | ')
    const label = ROWS.find(([, pattern]) => pattern.test(joined))
    if (label !== undefined) row = label[0]
    if (/OFF-?PEAK/i.test(joined)) tier = 'offPeak'
    else if (/\bPEAK\b/i.test(joined)) tier = 'peak'

    if (row === null || tier === null) continue

    const columns = cells.map((cell, index) => ({ index, values: dollars(cell) })).filter((column) => column.values.length > 0)
    if (columns.length < order.length) continue
    const prices = columns.slice(-order.length)
    prices.forEach((column, position) => {
      table[order[position]][row][tier] = column.values[0]
    })
  }

  const complete = Object.values(table).every(
    (model) =>
      model.cacheHit.offPeak !== undefined &&
      model.cacheHit.peak !== undefined &&
      model.cacheMiss.offPeak !== undefined &&
      model.cacheMiss.peak !== undefined &&
      model.output.offPeak !== undefined &&
      model.output.peak !== undefined,
  )
  return complete ? table : null
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Tabela corrente: cache em disco quando existir, senao os valores embutidos.
 *
 * Rotulos e apelidos de rota vem SEMPRE dos defaults (a pagina oficial nao os
 * publica), com o cache podendo sobrescrever chave a chave — assim um apelido
 * novo em price-defaults.json passa a valer sem apagar o cache.
 *
 * @returns tarifas por modelo, com origem e data da leitura.
 */
export async function readPricing() {
  const cached = await readJson(CACHE_PATH)
  const defaults = await readJson(DEFAULTS_PATH)
  if (cached?.models !== undefined) {
    return {
      ...cached,
      labels: { ...(defaults?.labels ?? {}), ...(cached.labels ?? {}) },
      routingAliases: { ...(defaults?.routingAliases ?? {}), ...(cached.routingAliases ?? {}) },
    }
  }
  if (defaults?.models !== undefined) return defaults
  return { source: 'unavailable', fetchedAt: null, models: {} }
}

/**
 * Baixa a pagina oficial e regrava o cache quando ele estiver vencido.
 * @param logger - opcional; falhas de rede sao relatadas, nunca lancadas.
 * @param force - ignora a idade do cache e baixa sempre.
 * @returns a tabela em vigor depois da tentativa.
 */
export async function refreshPricing(logger, force = false) {
  const current = await readPricing()
  const age = current.fetchedAt == null ? Infinity : Date.now() - Date.parse(current.fetchedAt)
  if (!force && current.source === 'deepseek-docs' && age < REFRESH_INTERVAL_MS) return current

  try {
    const response = await fetch(PRICING_URL, {
      headers: { 'user-agent': 'dsh-cost-meter/1.0 (local price sync)' },
      signal: AbortSignal.timeout(20000),
    })
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
    const models = parsePricing(await response.text())
    if (models === null) throw new Error('tabela de precos nao reconhecida na pagina')
    const next = {
      source: 'deepseek-docs',
      url: PRICING_URL,
      fetchedAt: new Date().toISOString(),
      models,
      labels: current.labels ?? {},
      routingAliases: current.routingAliases ?? {},
    }
    await writeFile(CACHE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    return next
  } catch (error) {
    logger?.(`cost-meter: falha ao atualizar precos (${error instanceof Error ? error.message : String(error)})`)
    return current
  }
}
