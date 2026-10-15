/**
 * Confere a matematica do custo: soma os buckets de tokens das amostras e
 * recalcula o valor com a tabela de precos, mostrando a composicao.
 *
 * Uso:  node scripts/inspect-cost-math.mjs
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { listSessionLogs, readSessionLog, usageSamples, isPeak } from '../lib/aggregate.mjs'
import { readPricing } from '../lib/pricing.mjs'

const sessionsRoot = join(homedir(), '.dsh', 'sessions')
const pricing = await readPricing()
const logs = await listSessionLogs(sessionsRoot)

const buckets = { uncached: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
let offPeakSamples = 0
let peakSamples = 0
let total = 0

for (const log of logs) {
  const parsed = await readSessionLog(log.path)
  for (const sample of usageSamples(parsed)) {
    buckets.uncached += sample.uncachedInputTokens
    buckets.output += sample.outputTokens
    buckets.cacheRead += sample.cacheReadTokens
    buckets.cacheWrite += sample.cacheWriteTokens
    if (isPeak(sample.at)) peakSamples += 1
    else offPeakSamples += 1

    const id = 'deepseek-flash'
    const rates = pricing.models[id]
    const tier = isPeak(sample.at) ? 'peak' : 'offPeak'
    total +=
      ((sample.uncachedInputTokens + sample.cacheWriteTokens) * rates.cacheMiss[tier] +
        sample.cacheReadTokens * rates.cacheHit[tier] +
        sample.outputTokens * rates.output[tier]) /
      1e6
  }
}

const fmt = (value) => value.toLocaleString('pt-BR')
console.log('buckets de tokens (todas as sessoes):')
console.log(`  entrada sem cache : ${fmt(buckets.uncached)}`)
console.log(`  entrada cache hit : ${fmt(buckets.cacheRead)}`)
console.log(`  saida             : ${fmt(buckets.output)}`)
console.log(`  cache write       : ${fmt(buckets.cacheWrite)}`)
console.log(`  TOTAL             : ${fmt(buckets.uncached + buckets.cacheRead + buckets.output + buckets.cacheWrite)}`)
console.log(`\namostras off-peak: ${String(offPeakSamples)}  peak: ${String(peakSamples)}`)
console.log(`custo recalculado : US$ ${total.toFixed(6)}`)
console.log(`origem dos precos : ${pricing.source}`)
