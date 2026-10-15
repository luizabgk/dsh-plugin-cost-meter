/**
 * Gera lib/client.js a partir de lib/client.template.js.
 *
 * O bundle precisa existir para o DSH carregar a metade cliente do plugin, e ele
 * carrega uma "semente" com o ultimo relatorio de custo. Essa semente e dado
 * pessoal (ids de sessao + valores), entao o repositorio versiona a versao
 * GERADA COM SEMENTE VAZIA:
 *
 *   node scripts/build-bundle.mjs --empty     # para versionar (sem dados)
 *   node scripts/build-bundle.mjs             # com o seu relatorio real
 *
 * A semente so serve de valor inicial/offline: o badge busca o valor fresco na
 * rota do host a cada 10 s.
 *
 * Uso:  node scripts/build-bundle.mjs [--empty]
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TEMPLATE = join(PACKAGE_ROOT, 'lib', 'client.template.js')
const BUNDLE = join(PACKAGE_ROOT, 'lib', 'client.js')
const DEFAULTS = join(PACKAGE_ROOT, 'price-defaults.json')
const MARKER = '__COST_METER_SEED__'

/** Semente sem nenhum dado pessoal, com as tarifas publicas embutidas. */
function emptySeed(defaults) {
  const now = new Date()
  return {
    generatedAt: null,
    currentMonth: `${String(now.getUTCFullYear())}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
    pricingSource: defaults.source ?? 'embedded-defaults',
    pricingFetchedAt: defaults.fetchedAt ?? null,
    pricingUrl: defaults.url ?? null,
    rates: defaults.models ?? {},
    labels: defaults.labels ?? {},
    routingAliases: defaults.routingAliases ?? {},
    sessionsScanned: 0,
    unpricedSamples: 0,
    months: {},
    sessions: {},
  }
}

const wantEmpty = process.argv.includes('--empty')
let seed

if (wantEmpty) {
  seed = emptySeed(JSON.parse(await readFile(DEFAULTS, 'utf8')))
  console.log('semente: VAZIA (nenhum dado pessoal)')
} else {
  const { writeCostReport } = await import('./write-costs.mjs')
  seed = await writeCostReport({ out: null })
  console.log(`semente: relatorio real (${String(Object.keys(seed.sessions).length)} sessao(oes))`)
}

const template = await readFile(TEMPLATE, 'utf8')
if (!template.includes(MARKER)) throw new Error(`o template nao tem o marcador ${MARKER}`)
await writeFile(BUNDLE, template.replace(MARKER, JSON.stringify(seed).replace(/</g, '\\u003c')), 'utf8')
console.log(`bundle gravado: ${BUNDLE}`)
