/**
 * Testes da agregacao host (lib/aggregate.mjs).
 *
 * O bug que motivou estes testes: o evento que declara o modelo
 * (`request/header`) NAO carrega tokens, e o que carrega tokens
 * (`assistant/message`) NAO declara o modelo. A primeira versao atualizava o
 * "modelo atual" DEPOIS de descartar eventos sem tokens, entao toda a sessao
 * herdava o primeiro modelo do log — e o custo saia subestimado (~2x menor)
 * sempre que o usuario trocava para um modelo mais caro.
 *
 * Uso:  node scripts/test-aggregate.mjs
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sampleCost, usageSamples } from '../lib/aggregate.mjs'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const defaults = JSON.parse(await readFile(join(PACKAGE_ROOT, 'price-defaults.json'), 'utf8'))
const pricing = { models: defaults.models, labels: defaults.labels, routingAliases: defaults.routingAliases }

let failures = 0
const check = (label, condition, detail = '') => {
  console.log(`${condition ? '  OK  ' : 'FALHA'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!condition) failures += 1
}

/** Log sintetico com a MESMA forma do DSH real. */
const BASE = 1792000000000
const log = {
  header: { createdAt: BASE },
  events: [
    { type: 'request/header', seq: 1, time: BASE, data: { header: { config: { model: 'deepseek-flash' } } } },
    {
      type: 'assistant/message',
      seq: 2,
      time: BASE + 1000,
      data: { message: { usage: { uncachedInputTokens: 1000, outputTokens: 100, cacheReadTokens: 5000 } } },
    },
    // troca explicita pelo model/selection (sem request/header no meio)
    { type: 'model/selection', seq: 3, time: BASE + 2000, data: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
    {
      type: 'assistant/message',
      seq: 4,
      time: BASE + 3000,
      data: { message: { usage: { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 30 } } },
    },
    // troca por request/header, para um nome aposentado (cobrado como Flash)
    {
      type: 'request/header',
      seq: 5,
      time: BASE + 4000,
      data: { header: { config: { model: 'deepseek-v4-flash-vision-exp' } } },
    },
    { type: 'assistant/message', seq: 6, time: BASE + 5000, data: { message: { usage: { outputTokens: 7 } } } },
  ],
}

console.log('— atribuicao de modelo por amostra —')
const samples = usageSamples(log)
check('extraiu as 3 amostras de uso', samples.length === 3, `obteve ${String(samples.length)}`)
check('amostra 1 = deepseek-flash', samples[0]?.model === 'deepseek-flash', String(samples[0]?.model))
check(
  'amostra 2 = deepseek-v4-pro (model/selection)',
  samples[1]?.model === 'deepseek-v4-pro',
  String(samples[1]?.model),
)
check(
  'amostra 3 = deepseek-v4-flash-vision-exp (request/header)',
  samples[2]?.model === 'deepseek-v4-flash-vision-exp',
  String(samples[2]?.model),
)
check('tokens da amostra 1 chegaram', samples[0]?.uncachedInputTokens === 1000 && samples[0]?.cacheReadTokens === 5000)
check('tokens da amostra 3 chegaram', samples[2]?.outputTokens === 7)

console.log('\n— o custo acompanha o modelo (nao o primeiro do log) —')
const bucket = { uncachedInputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
const at = BASE
const flash = sampleCost({ model: 'deepseek-flash', at, ...bucket }, pricing)
const pro = sampleCost({ model: 'deepseek-v4-pro', at, ...bucket }, pricing)
check('flash tem preco', flash.priced && flash.usd > 0, `US$ ${flash.usd.toFixed(4)}`)
check('pro tem preco', pro.priced && pro.usd > 0, `US$ ${pro.usd.toFixed(4)}`)
// 0,66 / 0,15 = 4,4 — a razao independe de ser peak ou off-peak
const razao = pro.usd / flash.usd
check('pro custa 4,4x o flash no cache miss', Math.abs(razao - 4.4) < 1e-9, `razao ${razao.toFixed(4)}`)
check('modelo desconhecido nao tem preco', sampleCost({ model: 'modelo-inexistente', at, ...bucket }, pricing).priced === false)

console.log('\n— custo total do log sintetico usa os dois modelos —')
const total = samples.reduce((acc, sample) => acc + sampleCost(sample, pricing).usd, 0)
const soFlash = samples.reduce((acc, sample) => acc + sampleCost({ ...sample, model: 'deepseek-flash' }, pricing).usd, 0)
check('total > tudo-como-flash', total > soFlash, `US$ ${total.toFixed(6)} > US$ ${soFlash.toFixed(6)}`)

console.log(failures === 0 ? '\nTUDO OK' : `\n${String(failures)} verificacao(oes) falharam`)
process.exitCode = failures === 0 ? 0 : 1
