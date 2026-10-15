/**
 * Agregacao de custo do DSH a partir dos logs de sessao.
 *
 * Por que ler o log em vez de usar a projecao `tokenUsage` do DSH: aquela
 * projecao acumula a SESSAO inteira, e uma sessao pode trocar de modelo no meio
 * (o wire dela nao carrega o modelo). O log, ao contrario, guarda cada pedido
 * com o modelo usado — unica granularidade que permite separar custo por modelo.
 *
 * O arquivo de sessao e JSONL com DOIS detalhes que importam:
 *   1. os dados vem comprimidos em varios frames zstd concatenados (um por
 *      linha), entao e preciso um descompressor em fluxo, nao um de um tiro so;
 *   2. a primeira linha e o cabecalho da sessao (id, cwd, createdAt).
 */
import { zstdDecompressSync } from 'node:zlib'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Descomprime um arquivo zstd com VARIOS frames concatenados (um por linha do
 * JSONL). O binding zstd do Node para no primeiro frame, tanto na via sincrona
 * quanto na de fluxo, entao os frames sao localizados pelo magic e decodificados
 * um a um.
 * @param buffer - conteudo bruto do arquivo.
 * @returns o texto JSONL completo.
 */
export function decompressZstd(buffer) {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (buffer[index] === magic[0] && buffer[index + 1] === magic[1] && buffer[index + 2] === magic[2] && buffer[index + 3] === magic[3]) {
      starts.push(index)
    }
  }
  if (starts.length <= 1) return zstdDecompressSync(buffer).toString('utf8')

  const parts = []
  for (let index = 0; index < starts.length; index += 1) {
    const slice = buffer.subarray(starts[index], starts[index + 1] ?? buffer.length)
    try {
      parts.push(zstdDecompressSync(slice).toString('utf8'))
    } catch {
      /* frame truncado (log em escrita): o que ja veio basta */
    }
  }
  return parts.join('')
}

/** Lista os arquivos de log de sessao sob a raiz de sessoes do DSH. */
export async function listSessionLogs(dshSessionsRoot) {
  const found = []
  const workspaces = await readdir(dshSessionsRoot, { withFileTypes: true }).catch(() => [])
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const workspacePath = join(dshSessionsRoot, workspace.name)
    for (const session of await readdir(workspacePath, { withFileTypes: true }).catch(() => [])) {
      if (!session.isDirectory()) continue
      const dir = join(workspacePath, session.name)
      for (const file of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (!file.isFile() || !file.name.startsWith('session.')) continue
        const path = join(dir, file.name)
        found.push({ path, sessionId: session.name, size: (await stat(path)).size })
      }
    }
  }
  return found
}

/** Le um log de sessao devolvendo cabecalho e eventos. */
export async function readSessionLog(path) {
  const raw = await readFile(path)
  const text = path.endsWith('.zstd') ? decompressZstd(raw) : raw.toString('utf8')
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      /* linha truncada no fim do log: ignorar */
    }
  }
  const [header, ...events] = rows
  return { header, events }
}

/** Valores numericos de um objeto de uso, tolerando nomes alternativos. */
function bucketsOf(object) {
  const read = (...names) => {
    for (const name of names) {
      const value = object?.[name]
      if (typeof value === 'number' && Number.isFinite(value)) return value
    }
    return 0
  }
  return {
    uncachedInputTokens: read('uncachedInputTokens', 'input_tokens', 'prompt_tokens', 'inputTokens'),
    outputTokens: read('outputTokens', 'output_tokens', 'completion_tokens', 'output'),
    cacheReadTokens: read('cacheReadTokens', 'cache_read_input_tokens', 'prompt_cache_hit_tokens', 'cachedInputTokens'),
    cacheWriteTokens: read('cacheWriteTokens', 'cache_write_input_tokens', 'prompt_cache_miss_tokens'),
  }
}

/** Procura recursivamente o primeiro objeto com cara de amostra de uso. */
function findUsage(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 4) return null
  const keys = Object.keys(value)
  if (keys.some((key) => /usage/i.test(key))) {
    const nested = findUsage(value[keys.find((key) => /usage/i.test(key))], depth + 1)
    if (nested !== null) return nested
  }
  const direct = bucketsOf(value)
  if (direct.outputTokens > 0 || direct.uncachedInputTokens > 0 || direct.cacheReadTokens > 0) return direct
  for (const key of keys) {
    const nested = findUsage(value[key], depth + 1)
    if (nested !== null) return nested
  }
  return null
}

/**
 * Modelo associado a um evento.
 *
 * O DSH registra a rota usada em `request/header` -> `data.header.config.model`
 * (autoritativo: e o que o pedido realmente usou) e a escolha do usuario em
 * `model/selection` -> `data.model`. Os demais caminhos cobrem variacoes de
 * envelope para nao depender de um unico formato.
 */
function modelOf(event) {
  const candidates = [
    event?.data?.header?.config?.model,
    event?.data?.header?.model,
    event?.data?.model,
    event?.model,
    event?.request?.model,
    event?.requestHeader?.model,
    event?.header?.model,
    event?.envelope?.model,
    event?.usage?.model,
    event?.meta?.model,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return null
}

/** Instante do evento, em ms, tolerando epoch em segundos e campos usuais. */
function timeOf(event, fallback) {
  const value = event?.ts ?? event?.timestamp ?? event?.time ?? event?.at ?? event?.createdAt
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return fallback
}

/** Chave AAAAMM em UTC, para a virada de mes. */
export function monthKey(ms) {
  const date = new Date(ms)
  return `${String(date.getUTCFullYear())}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * Extrai as amostras de uso (modelo, instante, tokens) de um log.
 *
 * ORDEM IMPORTA: o evento que declara o modelo (`request/header`) NAO carrega
 * tokens, e o evento que carrega tokens (`assistant/message`) NAO declara o
 * modelo. Entao o modelo precisa ser lembrado ANTES do descarte das amostras —
 * atualizar `currentModel` depois do `continue` fazia toda a sessao herdar o
 * primeiro modelo do log, subestimando o custo quando o modelo trocava.
 *
 * @param log - resultado de readSessionLog.
 * @returns amostras na ordem do log.
 */
export function usageSamples(log) {
  const fallback = typeof log.header?.createdAt === 'number' ? log.header.createdAt : Date.now()
  const samples = []
  let currentModel = null
  for (const event of log.events) {
    const declared = modelOf(event)
    if (declared !== null) currentModel = declared
    const tokens = findUsage(event)
    if (tokens === null) continue
    samples.push({ model: currentModel, at: timeOf(event, fallback), ...tokens })
  }
  return samples
}

/** Janela de pico da DeepSeek: 01:00-04:00 e 06:00-10:00 UTC, de segunda a sexta. */
export function isPeak(atMs) {
  const date = new Date(atMs)
  const day = date.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = date.getUTCHours()
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)
}

/** Resolve o id de preco de um modelo, aceitando apelidos aposentados. */
export function priceIdOf(model, pricing) {
  if (typeof model !== 'string') return null
  const aliases = pricing?.routingAliases ?? {}
  if (aliases[model] !== undefined) return aliases[model]
  const ids = Object.keys(pricing?.models ?? {})
  const exact = ids.find((id) => id === model)
  if (exact !== undefined) return exact
  return ids.find((id) => model.includes(id) || id.includes(model)) ?? null
}

/**
 * Custo de uma amostra de uso, em USD.
 *
 * O preco de cache miss vale para entrada nao cacheada; cache write e cobrado
 * como entrada (a API da DeepSeek nao expoe tarifa propria de escrita).
 */
export function sampleCost(sample, pricing) {
  const id = priceIdOf(sample.model, pricing)
  const rates = id === null ? undefined : pricing?.models?.[id]
  if (rates === undefined) return { usd: 0, priced: false }
  const tier = isPeak(sample.at) ? 'peak' : 'offPeak'
  const perMillion = 1e6
  const usd =
    ((sample.uncachedInputTokens + sample.cacheWriteTokens) * (rates.cacheMiss[tier] ?? 0) +
      sample.cacheReadTokens * (rates.cacheHit[tier] ?? 0) +
      sample.outputTokens * (rates.output[tier] ?? 0)) /
    perMillion
  return { usd, priced: true }
}

/**
 * Agrega o custo de todas as sessoes, por mes e por modelo.
 *
 * O relatorio carrega tambem os rotulos legiveis e a tabela de precos em vigor,
 * para que a camada de UI case o nome exibido com o custo sem recalcular tarifas
 * nem depender de um import extra no browser.
 *
 * @param options - raiz das sessoes, tabela de precos e instante de referencia.
 * @returns totais por mes/modelo e por sessao, mais metadados de preco.
 */
export async function aggregateCosts({ sessionsRoot, pricing, now = Date.now() }) {
  const logs = await listSessionLogs(sessionsRoot)
  const months = {}
  const sessions = {}
  let unpriced = 0

  for (const log of logs) {
    let parsed
    try {
      parsed = await readSessionLog(log.path)
    } catch {
      continue
    }
    const samples = usageSamples(parsed)
    sessions[log.sessionId] = { tokens: 0, usd: 0, samples: 0, byModel: {} }
    for (const sample of samples) {
      const month = monthKey(sample.at)
      const { usd, priced } = sampleCost(sample, pricing)
      if (!priced) unpriced += 1
      const tokens =
        sample.uncachedInputTokens + sample.outputTokens + sample.cacheReadTokens + sample.cacheWriteTokens
      const modelId = priceIdOf(sample.model, pricing) ?? sample.model ?? 'desconhecido'

      months[month] ??= { usd: 0, byModel: {} }
      months[month].usd += usd
      months[month].byModel[modelId] ??= { usd: 0, tokens: 0, samples: 0 }
      months[month].byModel[modelId].usd += usd
      months[month].byModel[modelId].tokens += tokens
      months[month].byModel[modelId].samples += 1

      const session = sessions[log.sessionId]
      session.usd += usd
      session.tokens += tokens
      session.samples += 1
      session.byModel[modelId] ??= { usd: 0, tokens: 0 }
      session.byModel[modelId].usd += usd
      session.byModel[modelId].tokens += tokens
    }
    sessions[log.sessionId].updatedAt = now
  }

  return {
    generatedAt: new Date(now).toISOString(),
    currentMonth: monthKey(now),
    pricingSource: pricing?.source ?? 'unknown',
    pricingFetchedAt: pricing?.fetchedAt ?? null,
    pricingUrl: pricing?.url ?? null,
    rates: pricing?.models ?? {},
    labels: pricing?.labels ?? {},
    routingAliases: pricing?.routingAliases ?? {},
    sessionsScanned: logs.length,
    unpricedSamples: unpriced,
    months,
    sessions,
  }
}
