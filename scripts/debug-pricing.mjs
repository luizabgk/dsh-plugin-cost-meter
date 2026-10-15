/** Diagnostico: dump de todas as linhas da tabela com indice. */
import { PRICING_URL, parseTableRows } from '../pricing.mjs'
import { readFile } from 'node:fs/promises'

const useCache = process.argv.includes('--cache')
const html = useCache
  ? await readFile(new URL('../price-page-sample.html', import.meta.url), 'utf8')
  : await (await fetch(PRICING_URL, { headers: { 'user-agent': 'dsh-cost-meter/1.0 (debug)' } })).text()

if (!useCache) {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(new URL('../price-page-sample.html', import.meta.url), html, 'utf8')
  console.log('(pagina salva em price-page-sample.html para iterar offline)\n')
}

parseTableRows(html).forEach((cells, index) => console.log(`${String(index).padStart(3)}: ${JSON.stringify(cells)}`))
