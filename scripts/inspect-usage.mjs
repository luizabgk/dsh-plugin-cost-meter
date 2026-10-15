/**
 * Auditoria das amostras de uso do log de sessao.
 *
 * Responde: cada amostra de tokens vem de um evento unico, ou o host esta
 * contando o mesmo uso mais de uma vez (ex.: amostra de streaming + amostra
 * final do mesmo step)?
 *
 * Uso:  node scripts/inspect-usage.mjs
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { listSessionLogs, readSessionLog, usageSamples } from '../lib/aggregate.mjs'

const sessionsRoot = join(homedir(), '.dsh', 'sessions')
const logs = await listSessionLogs(sessionsRoot)

for (const log of logs) {
  const parsed = await readSessionLog(log.path)
  if (parsed.events.length === 0) continue
  console.log(`\n=== ${log.sessionId} — ${String(parsed.events.length)} eventos ===`)

  // Quais tipos de evento carregam tokens, e quantos por step?
  const byType = new Map()
  const byStep = new Map()
  for (const event of parsed.events) {
    const text = JSON.stringify(event)
    const hasTokens = /"outputTokens"|"output_tokens"|"inputTokens"|"input_tokens"|"usage"/.test(text)
    if (!hasTokens) continue
    const type = String(event.type ?? '???')
    byType.set(type, (byType.get(type) ?? 0) + 1)

    const step = `${String(event.turn ?? event.data?.turn ?? '?')}/${String(event.step ?? event.data?.step ?? '?')}`
    byStep.set(step, (byStep.get(step) ?? 0) + 1)
  }

  console.log('tipos de evento com tokens:')
  for (const [type, count] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(4)}  ${type}`)
  }

  const duplicated = [...byStep.entries()].filter(([, count]) => count > 1)
  console.log(`steps com mais de um evento de tokens: ${String(duplicated.length)} de ${String(byStep.size)}`)
  for (const [step, count] of duplicated.slice(0, 8)) {
    console.log(`  step ${step}: ${String(count)} eventos`)
  }

  const samples = usageSamples(parsed)
  const somaAmostras = samples.reduce(
    (total, sample) =>
      total + sample.uncachedInputTokens + sample.outputTokens + sample.cacheReadTokens + sample.cacheWriteTokens,
    0,
  )
  console.log(`amostras extraidas: ${String(samples.length)}`)
  console.log(`tokens somados     : ${somaAmostras.toLocaleString('pt-BR')}`)
}
