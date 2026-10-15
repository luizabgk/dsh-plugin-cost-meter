/**
 * Instalador/reparador do cost-meter.
 *
 * Depois da mudanca para carregar o plugin por CAMINHO (a linha do patch aponta
 * para ./packages/dsh-plugin-cost-meter/lib/index.js), este script deixou de ser
 * obrigatorio: um `npm update` do dsh nao toca em nada do que a instalacao
 * depende. Ele existe para dois casos:
 *
 *   1. reparar a linha do patch se ela for perdida (ex.: ~/.dsh recriado);
 *   2. reembutir o relatorio de custo como semente do bundle (opcional — o
 *      badge ja busca o valor fresco na rota do host).
 *
 * Uso:  node scripts/install.mjs
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { summarize, writeCostReport } from './write-costs.mjs'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PROFILE = join(homedir(), '.dsh', 'profiles', 'web')
const PROFILE_PATCH = join(PROFILE, 'cordis.patch.yml')
const LEGACY_JUNCTION = join(PROFILE, 'node_modules', 'dsh-plugin-cost-meter')
const CLIENT_TEMPLATE = join(PACKAGE_ROOT, 'lib', 'client.template.js')
const CLIENT_BUNDLE = join(PACKAGE_ROOT, 'lib', 'client.js')

/** Caminho relativo ao arquivo de patch — sem node_modules envolvido. */
const PLUGIN_ENTRY = './packages/dsh-plugin-cost-meter/lib/index.js'

const PATCH_BLOCK = `# cost-meter: mostra o custo estimado em US$ (mes corrente + sessao atual) ao
# lado do nome do modelo no composer.
#
# A linha aponta para o ARQUIVO de entrada do pacote, resolvido a partir deste
# arquivo — de proposito. Assim a instalacao nao depende de nenhum link em
# node_modules (que uma atualizacao do dsh poderia refazer), apenas deste patch
# e da pasta packages/, que sao dados do usuario e ninguem reescreve.
- insert:
    - id: cost-meter
      name: ${PLUGIN_ENTRY}
`

/** Garante a linha do plugin na camada de patch do perfil (idempotente). */
async function ensurePatchRow() {
  const current = await readFile(PROFILE_PATCH, 'utf8').catch(() => null)
  if (current !== null && current.includes(PLUGIN_ENTRY)) return 'ja correta'

  if (current === null) {
    await mkdir(PROFILE, { recursive: true })
    await writeFile(PROFILE_PATCH, PATCH_BLOCK, 'utf8')
    return 'perfil criado'
  }

  const lines = current.split(/\r?\n/)
  const start = lines.findIndex((line) => line.includes('id: cost-meter'))
  if (start === -1) {
    await writeFile(PROFILE_PATCH, `${current.trimEnd()}\n\n${PATCH_BLOCK}`, 'utf8')
    return 'linha adicionada'
  }

  // Reescreve o bloco do cost-meter (a forma antiga apontava para o nome do
  // pacote e dependia do junction em node_modules).
  let blockStart = start
  while (blockStart > 0 && !lines[blockStart].trim().startsWith('- insert:')) blockStart -= 1
  let commentStart = blockStart
  while (commentStart > 0 && lines[commentStart - 1].trim().startsWith('#')) commentStart -= 1
  const next = [
    ...lines.slice(0, commentStart),
    ...PATCH_BLOCK.trimEnd().split('\n'),
    ...lines.slice(start + 2),
  ].join('\n')
  await writeFile(PROFILE_PATCH, `${next.trimEnd()}\n`, 'utf8')
  return 'linha atualizada para caminho'
}

/** Remove um junction legado — nao e mais necessario. */
async function removeLegacyJunction() {
  const info = await stat(LEGACY_JUNCTION).catch(() => null)
  if (info === null) return 'nao existia'
  await rm(LEGACY_JUNCTION, { recursive: true, force: true })
  return 'removido (nao e mais necessario)'
}

/** Reembute o relatorio no bundle do cliente (semente offline). */
async function embedSeed() {
  const report = await writeCostReport()
  const template = await readFile(CLIENT_TEMPLATE, 'utf8')
  if (!template.includes('__COST_METER_SEED__')) throw new Error('o template nao tem o marcador de seed')
  const seed = JSON.stringify(report).replace(/</g, '\\u003c')
  await writeFile(CLIENT_BUNDLE, template.replace('__COST_METER_SEED__', seed), 'utf8')
  return report
}

if (!existsSync(join(PACKAGE_ROOT, 'lib', 'index.js'))) throw new Error(`pacote incompleto em ${PACKAGE_ROOT}`)

const patch = await ensurePatchRow()
const junction = await removeLegacyJunction()
const report = await embedSeed()

console.log(`linha do patch    : ${patch}`)
console.log(`junction legado   : ${junction}`)
console.log(`bundle do cliente : ${CLIENT_BUNDLE}`)
console.log(`\n${summarize(report)}`)
console.log('\nNada mais a fazer: a instalacao nao depende de node_modules.')
console.log('Se o host estiver rodando, reinicie o `dsh web` uma vez e recarregue a pagina.')
