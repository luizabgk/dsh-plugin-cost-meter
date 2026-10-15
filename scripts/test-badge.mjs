/**
 * Teste do bundle do cliente sem navegador.
 *
 * O browser carrega o bundle pelo `window.__ModuleLoader__` e resolve `react`
 * na tabela de modulos da plataforma. Aqui fazemos o mesmo, com duas pecas
 * minimas: um DOM de mentira e um shim de React que respeita a ORDEM dos hooks
 * do componente — assim a logica real (rotulo, modelo, seed, formatacao) e
 * exercitada, mesmo sem um React de verdade.
 *
 * Uso:  node scripts/test-badge.mjs
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BUNDLE = join(PACKAGE_ROOT, 'lib', 'client.js')

let failures = 0
const check = (label, condition, detail = '') => {
	console.log(`${condition ? '  OK  ' : ' FALHA'} ${label}${detail === '' ? '' : ` — ${detail}`}`)
	if (!condition) failures += 1
}

/** Shim de React: mesma forma de elemento e mesma ordem de hooks. */
const hooks = { state: [], refs: [], effects: [] }
const react = {
	createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
	useState: (initial) => [initial, () => {}],
	useRef: (initial) => {
		hooks.refs.push({ current: initial })
		return hooks.refs[hooks.refs.length - 1]
	},
	useMemo: (factory) => factory(),
	useEffect: (fn) => {
		hooks.effects.push(fn)
	},
}

/** DOM minimo: CSS no head, botao do modelo com aria-label "Select model". */
const head = { children: [] }
const modelLabel = { textContent: 'DeepSeek-V4.1-Flash' }
const modelButton = {
	textContent: '',
	querySelector: (selector) => (String(selector).includes('triggerLabel') ? modelLabel : null),
	getAttribute: (name) => (name === 'aria-label' ? 'Select model, current DeepSeek-V4.1-Flash, reasoning effort Max' : null),
}
globalThis.window = {
	setInterval: () => 0,
	clearInterval: () => {},
	fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve(null) }),
	location: { href: 'http://127.0.0.1:3080/' },
}
globalThis.document = {
	head: { appendChild: (node) => head.children.push(node) },
	getElementById: () => null,
	createElement: (tag) => ({ tag, id: '', textContent: '' }),
	querySelector: (selector) => (String(selector).includes('Select model') ? modelButton : null),
}

let registered = null
globalThis.window.__ModuleLoader__ = { load: (definition) => { registered = definition } }

const source = await readFile(BUNDLE, 'utf8')
new Function('window', source)(globalThis.window)

console.log('— contrato do plugin —')
check('registrou no ModuleLoader', registered !== null)
check('id do plugin', registered?.id === 'dsh-plugin-cost-meter', registered?.id)

const plugin = registered.factory((request) => {
	if (request === 'react') return react
	throw new Error(`require inesperado: ${request}`)
})
check('exporta apply', typeof plugin.apply === 'function')
check('declara inject = [slots]', JSON.stringify(plugin.inject) === '["slots"]')

console.log('\n— registro no slot e CSS —')
let registration = null
plugin.apply({
	effect: (fn) => { fn() },
	inject: (services, callback) => {
		check('inject pede slots', JSON.stringify(services) === '["slots"]')
		callback({
			slots: {
				inject: (name, factory) => {
					const disposer = factory()
					return typeof disposer === 'function' ? disposer : () => {}
				},
				register: (options, component) => { registration = { options, component }; return () => {} },
			},
		})
	},
})
check('slot conversation.input.right', registration?.options?.name === 'conversation.input.right', registration?.options?.name)
check('componente e o Badge', registration?.component === plugin.Badge)
check('CSS injetado', head.children.length === 1)

console.log('\n— sessionId vem do slot (contrato oficial) —')
check('inject e funcao', typeof registration?.options?.inject === 'function')
const injected = registration?.options?.inject('session-teste-123')
check('inject devolve sessionId', injected?.sessionId === 'session-teste-123', JSON.stringify(injected))

console.log('\n— render do Badge (autoritativo do host) —')
const tree = plugin.Badge({ sessionId: 'session-teste-123' })
check('nao retornou null', tree !== null && tree !== undefined)

const walk = (node) => {
	if (typeof node === 'string') return node
	if (Array.isArray(node)) return node.map(walk).join('')
	return `${String(node?.type ?? '')} ${(node?.children ?? []).map(walk).join('')}`
}
const text = walk(tree).replace(/\s+/g, ' ').trim()
const title = tree?.props?.title ?? ''
console.log(`  texto: ${text}`)
console.log(`  title: ${title.split('\n')[0]} | ${String(title.split('\n')[1])} | ${String(title.split('\n')[2])}`)

check('classe do badge', String(tree?.props?.className).includes('dsh-cost-meter'))
check('mostra o modelo', text.includes('V4.1-Flash'))
check('mostra custo no mes', /US\$ [\d.,]+ no mes/.test(text))
check('mostra custo na sessao', /US\$ [\d.,]+ na sessao/.test(text))
check('title cita a fonte de precos', title.includes('tabela oficial da DeepSeek'))
check('title traz o mes', /Mes \d{4}-\d{2}/.test(title))
check('title traz o sessionId recebido', title.includes('session-teste-123'))

console.log('\n— integridade do seed embutido —')
const seedMatch = /const SEED = (\{.*?\});\n/s.exec(source)
check('seed presente no bundle', seedMatch !== null)
if (seedMatch !== null) {
	const seed = JSON.parse(seedMatch[1])
	const month = seed.months?.[seed.currentMonth]
	console.log(`  mes ${seed.currentMonth}: US$ ${Number(month?.usd ?? 0).toFixed(4)} | origem ${seed.pricingSource}`)
	for (const [id, model] of Object.entries(month?.byModel ?? {})) {
		console.log(`    ${id}: US$ ${model.usd.toFixed(4)} em ${model.tokens} tokens`)
	}
	check('mes corrente preenchido', /^\d{4}-\d{2}$/.test(seed.currentMonth ?? ''))
	check('tarifas no seed', Object.keys(seed.rates ?? {}).length >= 2, Object.keys(seed.rates ?? {}).join(', '))
	check('rotulos no seed', Object.keys(seed.labels ?? {}).length >= 2)
	const sum = Object.values(month?.byModel ?? {}).reduce((total, model) => total + model.usd, 0)
	check('soma por modelo = total do mes', Math.abs(sum - (month?.usd ?? 0)) < 1e-9)
}

console.log('\n— custo vem so do host (sem contagem dupla) —')
check('le o mes do relatorio do host', source.includes('data.currentMonth'))
check('nao soma delta no browser', !source.includes('setDelta') && !source.includes('bySession'))
check('usa a verdade do host por sessao', source.includes('data.sessions?.[sessionId]'))

console.log('\n— reconhecimento do nome do modelo —')
// Os rotulos do composer mudam entre versoes; os nomes aposentados sao
// cobrados como Flash. Este bloco existe porque o badge ja mostrou US$ 0,00
// indevidamente para "V4-Flash-Vision-Exp".
const fakeRates = {
	'deepseek-flash': { cacheHit: { offPeak: 0.003 }, cacheMiss: { offPeak: 0.15 }, output: { offPeak: 0.6 } },
	'deepseek-v4-pro': { cacheHit: { offPeak: 0.022 }, cacheMiss: { offPeak: 0.66 }, output: { offPeak: 1.98 } },
}
const fakeData = {
	rates: fakeRates,
	labels: { 'deepseek-flash': 'DeepSeek-V4.1-Flash', 'deepseek-v4-pro': 'DeepSeek-V4-Pro' },
	routingAliases: { 'deepseek-v4-flash-vision-exp': 'deepseek-flash' },
}
for (const [label, expected] of [
	['V4-Flash-Vision-Exp', 'deepseek-flash'],
	['V4.1-Flash', 'deepseek-flash'],
	['V4-Flash', 'deepseek-flash'],
	['DeepSeek-V4.1-Flash', 'deepseek-flash'],
	['deepseek-flash', 'deepseek-flash'],
	['deepseek-v4-flash-vision-exp', 'deepseek-flash'],
	['V4-Pro', 'deepseek-v4-pro'],
	['DeepSeek-V4-Pro', 'deepseek-v4-pro'],
	['deepseek-v4-pro', 'deepseek-v4-pro'],
]) {
	const actual = plugin.priceIdOf(label, fakeData)
	check(`${label} -> ${expected}`, actual === expected, actual === expected ? '' : `obteve ${String(actual)}`)
}
check('nome desconhecido -> null', plugin.priceIdOf('Modelo-Inexistente', fakeData) === null)

console.log('\n— atualizacao automatica pelo host —')
check('consulta a rota do host', source.includes("'/cost-meter/report.json'"))
check('intervalo de consulta definido', /POLL_MS = \d+/.test(source))
check('tick de re-render definido', /TICK_MS = \d+/.test(source))
check('falha de rede nao quebra o badge', source.includes('.catch(() => {})'))
check('ignora relatorio ainda pendente', source.includes('fresh.pending === true'))
check('resolve contra a origem real do app', source.includes('new URL(`../'))
check('semente continua como fallback', source.includes('react.useState(SEED)'))

console.log(failures === 0 ? '\nTUDO OK' : `\n${String(failures)} verificacao(oes) falharam`)
process.exitCode = failures === 0 ? 0 : 1
