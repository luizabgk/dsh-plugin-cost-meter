/**
 * Conferencia do parser de precos: baixa a pagina oficial, extrai a tabela e
 * compara com os valores embutidos em price-defaults.json.
 *
 * Uso:  node scripts/check-pricing.mjs
 */
import { readFile } from 'node:fs/promises'
import { parsePricing, PRICING_URL, DEFAULTS_PATH } from '../lib/pricing.mjs'

const defaults = JSON.parse(await readFile(DEFAULTS_PATH, 'utf8'))
const response = await fetch(PRICING_URL, { headers: { 'user-agent': 'dsh-cost-meter/1.0 (check)' } })
const html = await response.text()
const parsed = parsePricing(html)

if (parsed === null) {
  console.error('FALHA: o parser nao reconheceu a tabela da pagina.')
  process.exitCode = 1
} else {
  console.log('Tabela extraida da pagina:\n')
  console.log(JSON.stringify(parsed, null, 2))
  const ids = Object.keys(parsed)
  const flashed = parsed['deepseek-flash']
  console.log('\nSanidade:')
  console.log(`  modelos encontrados : ${ids.join(', ')}`)
  console.log(`  flash cache-miss    : ${String(flashed.cacheMiss.offPeak)} off-peak (esperado ${String(defaults.models['deepseek-flash'].cacheMiss.offPeak)})`)
  console.log(`  flash output        : ${String(flashed.output.offPeak)} off-peak (esperado ${String(defaults.models['deepseek-flash'].output.offPeak)})`)
  console.log(`  flash eh o dobro?   : peak ${String(flashed.output.peak)} = 2 x off-peak ${String(flashed.output.offPeak)} -> ${flashed.output.peak === flashed.output.offPeak * 2 ? 'OK' : 'CONFERIR'}`)
}
