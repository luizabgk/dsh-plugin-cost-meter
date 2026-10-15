/**
 * Roda a agregacao sobre os logs reais desta maquina e imprime o resultado.
 * Serve para conferir os numeros antes de mostra-los na GUI.
 *
 * Uso:  node scripts/check-costs.mjs [--debug]
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readPricing } from '../lib/pricing.mjs'
import { aggregateCosts, listSessionLogs, readSessionLog, usageSamples } from '../lib/aggregate.mjs'

const sessionsRoot = join(homedir(), '.dsh', 'sessions')
const pricing = await readPricing()

if (process.argv.includes('--debug')) {
  const logs = await listSessionLogs(sessionsRoot)
  console.log(`logs: ${String(logs.length)}`)
  for (const log of logs) {
    const parsed = await readSessionLog(log.path)
    const samples = usageSamples(parsed)
    console.log(`\n=== ${log.sessionId} (${String(log.size)} bytes) ===`)
    console.log(`eventos: ${String(parsed.events.length)}  amostras de uso: ${String(samples.length)}`)
    if (samples[0] !== undefined) console.log(`primeira amostra: ${JSON.stringify(samples[0])}`)
    console.log(`modelos vistos: ${[...new Set(samples.map((sample) => sample.model))].join(', ')}`)
  }
  console.log('')
}

const report = await aggregateCosts({ sessionsRoot, pricing })
console.log(JSON.stringify(report, null, 2))
