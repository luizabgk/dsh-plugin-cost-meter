/**
 * Caminhos do pacote, num lugar so.
 *
 * Existe para que lib/ e scripts/ concordem sobre onde ficam os arquivos, sem
 * um importar o outro (script nenhum deve rodar por efeito de importacao).
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** Raiz do pacote (um nivel acima de lib/). */
export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Relatorio de custo gravado pelo host e usado como semente do bundle. */
export const COSTS_PATH = join(PACKAGE_ROOT, 'costs.json')
