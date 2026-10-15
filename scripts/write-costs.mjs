/**
 * Calcula e grava o relatorio de custo (costs.json).
 *
 * Roda dentro do host do DSH (pelo plugin) e tambem direto na linha de comando,
 * o que permite conferir os numeros sem abrir a GUI.
 *
 * Uso:  node scripts/write-costs.mjs [--print]
 */
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPricing } from '../lib/pricing.mjs'
import { aggregateCosts } from '../lib/aggregate.mjs'
import { COSTS_PATH } from '../lib/paths.mjs'

const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions')

/**
 * Calcula o relatorio e grava em costs.json.
 * @param options - raiz de sessoes alternativa e instante de referencia.
 * @returns o relatorio gravado.
 */
export async function writeCostReport({ sessionsRoot = SESSIONS_ROOT, now = Date.now(), out = COSTS_PATH } = {}) {
  const pricing = await readPricing()
  const report = await aggregateCosts({ sessionsRoot, pricing, now })
  if (out !== null) {
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }
  return report
}

/** Resumo legivel de um relatorio. */
export function summarize(report) {
  const month = report.months[report.currentMonth] ?? { usd: 0, byModel: {} }
  const lines = [
    `mes corrente : ${report.currentMonth} — US$ ${month.usd.toFixed(4)}`,
    `sessoes      : ${String(report.sessionsScanned)} (${String(report.unpricedSamples)} amostras sem preco)`,
    `precos       : ${report.pricingSource}${report.pricingFetchedAt === null ? '' : ` (${report.pricingFetchedAt})`}`,
    'por modelo   :',
  ]
  for (const [id, model] of Object.entries(month.byModel)) {
    lines.push(`  ${id.padEnd(18)} US$ ${model.usd.toFixed(4)}  ${String(model.tokens)} tokens  ${String(model.samples)} chamadas`)
  }
  return lines.join('\n')
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  (await realpath(process.argv[1]).catch(() => '')) === (await realpath(fileURLToPath(import.meta.url)).catch(() => null))

if (invokedDirectly) {
  const asJson = process.argv.includes('--json')
  const report = await writeCostReport({
    out: asJson ? null : COSTS_PATH,
  }).catch(async (error) => {
    // Sem permissao de escrita (ex.: sandbox), ainda assim calculamos para imprimir.
    if (error?.code !== 'EPERM') throw error
    const { readPricing } = await import('../lib/pricing.mjs')
    const { aggregateCosts } = await import('../lib/aggregate.mjs')
    return aggregateCosts({ sessionsRoot: SESSIONS_ROOT, pricing: await readPricing() })
  })
  if (asJson) console.log(JSON.stringify(report))
  else {
    console.log(summarize(report))
    if (process.argv.includes('--print')) console.log(`\n${JSON.stringify(report, null, 2)}`)
  }
}
