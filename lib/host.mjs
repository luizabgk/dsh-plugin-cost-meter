/**
 * Corpo do plugin host do cost-meter.
 *
 * Agrega os logs de sessao periodicamente (o browser nao descomprime zstd nem
 * le disco), grava costs.json — que serve de semente ao bundle e de material de
 * conferencia fora da GUI — e publica o mesmo relatorio numa rota HTTP propria.
 *
 * A rota `/cost-meter/report.json` e o que torna o badge automatico: o cliente
 * a consulta periodicamente e mostra o acumulado do mes sem reinstalar nada.
 */
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { aggregateCosts } from './aggregate.mjs'
import { readPricing, refreshPricing } from './pricing.mjs'
import { COSTS_PATH } from './paths.mjs'

/** Caminho exato da rota: vence a tabela de prefixo e o fallback do SPA. */
export const REPORT_PATH = '/cost-meter/report.json'

/** Recalculo periodico da agregacao (ms). */
const REFRESH_INTERVAL_MS = 30 * 1000

/** Falhas de rede nao podem impedir a ativacao do plugin. */
const logger = (message) => {
  try {
    console.log(message)
  } catch {
    /* console indisponivel: seguir em silencio */
  }
}

/**
 * Agrega os custos e regrava costs.json.
 * @param sessionsRoot - raiz dos logs de sessao do DSH.
 * @returns o relatorio, ou null quando a agregacao falhou.
 */
async function recompute(sessionsRoot) {
  try {
    const pricing = await readPricing()
    const report = await aggregateCosts({ sessionsRoot, pricing })
    await writeFile(COSTS_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    return report
  } catch (error) {
    logger(`cost-meter: falha ao agregar custos (${error instanceof Error ? error.message : String(error)})`)
    return null
  }
}

/**
 * Corpo do plugin host.
 * @param ctx - contexto cordis do host.
 */
export function apply(ctx) {
  const sessionsRoot = join(homedir(), '.dsh', 'sessions')
  let latest = null

  // Precos: uma vez no boot; o cache de 24 h decide se baixa de novo.
  ctx.effect(() => {
    let disposed = false
    refreshPricing(logger)
      .then((pricing) => {
        if (disposed) return
        logger(`cost-meter: precos ${pricing.source} (${Object.keys(pricing.models ?? {}).join(', ')})`)
      })
      .catch((error) => {
        logger(`cost-meter: precos indisponiveis (${error instanceof Error ? error.message : String(error)})`)
      })
    return () => {
      disposed = true
    }
  }, 'cost-meter: sincronizacao de precos')

  ctx.inject(['webServer'], (scope) => {
    // Agregacao no boot e a cada 30 s: e o que mantem o badge vivo.
    scope.effect(() => {
      let disposed = false
      recompute(sessionsRoot)
        .then((report) => {
          if (disposed || report === null) return
          latest = report
          const usd = report.months?.[report.currentMonth]?.usd ?? 0
          logger(`cost-meter: mes ${report.currentMonth} — US$ ${usd.toFixed(4)}`)
        })
        .catch(() => {})
      const timer = setInterval(() => {
        recompute(sessionsRoot)
          .then((report) => {
            if (!disposed && report !== null) latest = report
          })
          .catch(() => {})
      }, REFRESH_INTERVAL_MS)
      return () => {
        disposed = true
        clearInterval(timer)
      }
    }, 'cost-meter: agregacao periodica')

    scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path: REPORT_PATH,
          handler: (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              res.writeHead(405, { allow: 'GET, HEAD' })
              res.end()
              return
            }
            const body = JSON.stringify(latest ?? { pending: true, generatedAt: null })
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              'content-length': Buffer.byteLength(body),
            })
            res.end(req.method === 'HEAD' ? undefined : body)
          },
        }),
      'cost-meter: rota do relatorio',
    )
  })
}
