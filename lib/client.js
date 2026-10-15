/**
 * TEMPLATE do bundle cliente. Nao editar lib/client.js — ele e GERADO daqui
 * por scripts/install.mjs, que troca o marcador de seed (nome da constante
 * logo abaixo) pelo relatorio de custo mais recente.
 *
 * Medidor de custo ao lado do nome do modelo.
 *
 * Duas fontes de dado, de proposito:
 *
 * 1. SEED — relatorio gravado pelo host (scripts/write-costs.mjs), que varre
 *    TODAS as sessoes e portanto conhece o gasto do mes fechado e de sessoes
 *    antigas.
 * 2. A projecao `tokenUsage` da sessao aberta — tokens reais que o DSH
 *    reporta do provedor, usados para creditar em tempo real o que aconteceu
 *    depois do ultimo relatorio.
 *
 * O credito em tempo real e incremental: guarda os totais ja vistos da sessao
 * e atribui cada DIFERENCA ao modelo selecionado naquele momento, que e o que
 * permite separar custo por modelo quando a sessao troca de modelo no meio.
 */
window.__ModuleLoader__.load({
	id: 'dsh-plugin-cost-meter',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		let react = require('react');

		/** Relatorio do host embutido na instalacao (semente offline). */
		const SEED = {"generatedAt":null,"currentMonth":"2026-10","pricingSource":"embedded-defaults","pricingFetchedAt":"2026-10-27T00:00:00.000Z","pricingUrl":"https://api-docs.deepseek.com/quick_start/pricing","rates":{"deepseek-flash":{"label":"DeepSeek-V4.1-Flash","cacheHit":{"offPeak":0.003,"peak":0.006},"cacheMiss":{"offPeak":0.15,"peak":0.3},"output":{"offPeak":0.6,"peak":1.2}},"deepseek-v4-pro":{"label":"DeepSeek-V4-Pro","cacheHit":{"offPeak":0.022,"peak":0.044},"cacheMiss":{"offPeak":0.66,"peak":1.32},"output":{"offPeak":1.98,"peak":3.96}}},"labels":{"deepseek-flash":"DeepSeek-V4.1-Flash","deepseek-v4-pro":"DeepSeek-V4-Pro"},"routingAliases":{"deepseek-v4-flash":"deepseek-flash","deepseek-v4-flash-vision-exp":"deepseek-flash","deepseek-chat":"deepseek-flash","deepseek-reasoner":"deepseek-flash","V4-Flash-Vision-Exp":"deepseek-flash","V4-Flash":"deepseek-flash","V4.1-Flash":"deepseek-flash","DeepSeek-V4.1-Flash":"deepseek-flash","V4-Pro":"deepseek-v4-pro","DeepSeek-V4-Pro":"deepseek-v4-pro"},"sessionsScanned":0,"unpricedSamples":0,"months":{},"sessions":{}};

		/** Rota do host que publica o relatorio fresco. */
		const REPORT_PATH = '/cost-meter/report.json';

		/**
		 * URL da rota do host, resolvida contra a origem REAL do app.
		 *
		 * O DSH pode servir a GUI sob um caminho de proxy (ex.: /proxy/8080/), e
		 * um caminho absoluto escaparia do prefixo. Ancorar em window.location e
		 * subir um nivel devolve a raiz da aplicacao em ambos os casos.
		 */
		function reportUrl() {
			const here = window.location?.href ?? '';
			return new URL(`../${REPORT_PATH.replace(/^\//, '')}`, here).href;
		}

		/** Intervalo de consulta ao host (ms). */
		const POLL_MS = 10000;

		/** Intervalo de re-render para refletir troca de modelo/sessao (ms). */
		const TICK_MS = 2000;

		/**
		 * Resolve o id de preco a partir do nome exibido ou do id da rota.
		 *
		 * O rotulo do composer muda de forma ao longo das versoes ("V4.1-Flash",
		 * "V4-Flash-Vision-Exp", "DeepSeek-V4-Pro"...), e os nomes aposentados
		 * sao cobrados como Flash segundo a tabela oficial. Por isso, alem do
		 * casamento exato, ha um degrau por FAMILIA (flash/pro).
		 */
		function priceIdOf(model, data) {
			if (typeof model !== 'string' || model.length === 0) return null;
			const aliases = data.routingAliases ?? {};
			if (aliases[model] !== undefined) return aliases[model];
			const ids = Object.keys(data.rates ?? {});
			if (ids.includes(model)) return model;

			const normalize = (value) => String(value).toLowerCase().replace(/^deepseek[-_ ]?/, '').replace(/[^a-z0-9]/g, '');
			const normalized = normalize(model);

			const byLabel = Object.entries(data.labels ?? {}).find(([, label]) => normalize(label) === normalized);
			if (byLabel !== undefined) return byLabel[0];

			const contained = ids.find((id) => normalized.includes(normalize(id)) || normalize(id).includes(normalized));
			if (contained !== undefined) return contained;

			// Familia: "v4pro" -> pro; qualquer coisa com "flash" (inclusive os
			// nomes aposentados, cobrados como Flash) -> flash.
			if (normalized.includes('pro')) return ids.find((id) => normalize(id).includes('pro')) ?? null;
			if (normalized.includes('flash')) return ids.find((id) => normalize(id).includes('flash')) ?? null;
			return null;
		}

		/** Custo formatado com precisao util para centavos. */
		function formatUsd(value) {
			if (!Number.isFinite(value) || value <= 0) return 'US$ 0,00';
			if (value < 0.01) return `US$ ${value.toFixed(4).replace('.', ',')}`;
			return `US$ ${value.toFixed(2).replace('.', ',')}`;
		}

		/** Nome do modelo exibido no controle do composer. */
		function currentModelLabel() {
			// O trigger do modelo carrega aria-label "Select model, current X…";
			// o seletor de classe generico pegaria o botao "Settings" primeiro.
			const button = document.querySelector('button[aria-label^="Select model"]');
			const label = button?.querySelector('[class*="triggerLabel"]')?.textContent?.trim();
			if (label !== undefined && label !== '') return label;
			const aria = button?.getAttribute('aria-label') ?? '';
			const match = aria.match(/current\s+([^,]+)/);
			if (match !== null) return match[1].trim();
			const title = button?.getAttribute('title') ?? '';
			return title.split('·')[0].trim() || null;
		}

		/** Rotulo curto do modelo, para caber no badge. */
		function shortLabel(label, priceId, data) {
			const known = data.labels?.[priceId];
			const base = known ?? label ?? priceId ?? 'modelo';
			return base.replace(/^DeepSeek-/, '');
		}

		/** Sessao corrente, quando o shell a expoe no DOM. */
		function currentSessionId() {
			const node = document.querySelector('[data-session-id][data-active="true"], [aria-current="true"][data-session-id]');
			const id = node?.getAttribute('data-session-id');
			return typeof id === 'string' && id.length > 0 ? id : null;
		}

		const CSS = `
		.dsh-cost-meter{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border-radius:999px;
			background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary,#8a8a8a);
			font-size:11px;line-height:1;white-space:nowrap;font-variant-numeric:tabular-nums}
		.dsh-cost-meter .month b{font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
		.dsh-cost-meter .sep{opacity:.45}
		.dsh-cost-meter .session{color:var(--dsw-alias-label-caption,#9a9a9a)}
		`;

		/** Badge: custo do mes do modelo atual + custo da sessao aberta. */
		function Badge(props) {
			const [report, setReport] = react.useState(SEED);
			const [tick, setTick] = react.useState(0);
			const data = report;
			// A fabrica `inject` do slot entrega o sessionId — e o contrato
			// oficial. O DOM NAO carrega data-session-id, entao raspar o DOM
			// (tentativa anterior) deixava o custo da sessao sempre zerado.
			const propSessionId = typeof props?.sessionId === 'string' ? props.sessionId : null;

			// Consulta o host: ele reagrega os logs a cada 30 s e serve a VERDADE
			// do custo. O badge e autoritativo do host — nao soma nada no browser,
			// o que evita contar o mesmo gasto duas vezes.
			react.useEffect(() => {
				let alive = true;
				const pull = () => {
					window
						.fetch(reportUrl(), { credentials: 'same-origin' })
						.then((response) => (response.ok ? response.json() : null))
						.then((fresh) => {
							if (!alive || fresh === null || fresh.pending === true) return;
							setReport(fresh);
						})
						.catch(() => {});
				};
				pull();
				const timer = window.setInterval(pull, POLL_MS);
				return () => {
					alive = false;
					window.clearInterval(timer);
				};
			}, []);

			// Tick periodico: obriga re-render para refletir troca de modelo e de
			// sessao (o label e lido do DOM a cada render).
			react.useEffect(() => {
				const timer = window.setInterval(() => setTick((value) => value + 1), TICK_MS);
				return () => window.clearInterval(timer);
			}, []);

			const label = currentModelLabel();
			const priceId = priceIdOf(label, data) ?? 'desconhecido';
			// Sessao: o prop vem do slot (fonte oficial); o DOM e so reserva.
			const sessionId = propSessionId ?? currentSessionId();
			const month = data.currentMonth ?? '—';

			const monthUsd = data.months?.[month]?.byModel?.[priceId]?.usd ?? 0;
			const sessionUsd = sessionId === null ? 0 : (data.sessions?.[sessionId]?.usd ?? 0);

			// Detalhe por modelo DENTRO da sessao: explica o caso em que o modelo
			// selecionado agora difere do que a sessao realmente consumiu.
			const sessionModels = Object.entries(data.sessions?.[sessionId]?.byModel ?? {})
				.map(([id, model]) => `${data.labels?.[id] ?? id} ${formatUsd(model.usd)}`)
				.join(' · ');

			const title = [
				`Modelo selecionado: ${shortLabel(label, priceId, data)}`,
				`Mes ${month}: ${formatUsd(monthUsd)}`,
				`Esta sessao: ${formatUsd(sessionUsd)}${sessionId === null ? ' (sessao nao identificada)' : ''}`,
				sessionModels === '' ? null : `Modelos desta sessao: ${sessionModels}`,
				`Sessao: ${sessionId ?? '—'}`,
				`Precos: ${data.pricingSource ?? 'desconhecido'}${data.pricingFetchedAt == null ? '' : ` (${String(data.pricingFetchedAt).slice(0, 10)})`}`,
				'Estimativa: tokens reais medidos pelo DSH x tabela oficial da DeepSeek.',
			]
				.filter((line) => line !== null)
				.join('\n');

			return react.createElement(
				'div',
				{ className: 'dsh-cost-meter', title },
				react.createElement(
					'span',
					{ className: 'month' },
					`${shortLabel(label, priceId, data)} `,
					react.createElement('b', null, formatUsd(monthUsd)),
					' no mes',
				),
				react.createElement('span', { className: 'sep' }, '·'),
				react.createElement('span', { className: 'session' }, `${formatUsd(sessionUsd)} na sessao`),
			);
		}

		/** Injeta o CSS uma unica vez. */
		function installStyles() {
			const id = 'dsh-cost-meter-style';
			if (document.getElementById(id) !== null) return;
			const style = document.createElement('style');
			style.id = id;
			style.textContent = CSS;
			document.head.appendChild(style);
		}

		/**
		 * Corpo do plugin cliente.
		 *
		 * `conversation.input.right` e declarado como slot de LISTA pelo shell da
		 * conversa, entao acrescentar aqui nao desloca nem substitui o controle de
		 * modelo: o badge fica ao lado dele.
		 *
		 * @param ctx - contexto cordis do cliente.
		 */
		function apply(ctx) {
			ctx.effect(() => {
				installStyles();
			}, 'cost-meter: estilos');
			// Padrao exato do pacote nativo dsh-client-ui-model-selection:
			// ctx.inject([...]) -> scope.slots.inject(...) DIRETO, sem effect extra.
			ctx.inject(['slots'], (scope) => {
				scope.slots.inject('conversation.input.right', () =>
					scope.slots.register(
						{
							name: 'conversation.input.right',
							id: 'cost-meter',
							order: 100,
							// A fabrica recebe o sessionId do slot e o devolve como
							// prop do componente — fonte oficial, sem raspar o DOM.
							inject: (sessionId) => ({ sessionId }),
						},
						Badge,
					),
				);
			});
		}

		exports.apply = apply;
		exports.inject = ['slots'];
		exports.Badge = Badge;
		exports.priceIdOf = priceIdOf;
		return module.exports;
	},
});
