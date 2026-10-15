/**
 * Inspeciona a estrutura do log de sessao do DSH (um objeto JSON por arquivo)
 * para localizar onde ficam o modelo e o uso de tokens.
 *
 * Uso:  node scripts/inspect-session.mjs
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DSH_SESSIONS = join(homedir(), '.dsh', 'sessions')

async function findLogs() {
  const found = []
  for (const workspace of await readdir(DSH_SESSIONS, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue
    const workspacePath = join(DSH_SESSIONS, workspace.name)
    for (const session of await readdir(workspacePath, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const dir = join(workspacePath, session.name)
      for (const file of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, file.name)
        const info = await stat(path)
        if (info.isFile()) found.push({ path, size: info.size, session: session.name, name: file.name })
      }
    }
  }
  return found.sort((a, b) => b.size - a.size)
}

/** Log e JSONL: um objeto por linha (a primeira e o cabecalho da sessao). */
async function readLines(path) {
  const raw = await readFile(path)
  const text = path.includes('.zstd') ? zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8')
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

const logs = await findLogs()
console.log('arquivos de sessao:')
logs.slice(0, 10).forEach((log) => console.log(`  ${log.name}  ${String(log.size)} bytes  (${log.session})`))

const target = logs.find((log) => log.size > 1000)
if (target === undefined) process.exit(1)

const lines = await readLines(target.path)
const header = lines[0]
const events = lines.slice(1)

console.log(`\n=== ${target.path} ===`)
console.log(`cabecalho: ${JSON.stringify(header)}`)
console.log(`eventos: ${String(events.length)}`)

const kinds = new Map()
for (const event of events) {
  const kind = String(event?.type ?? event?.kind ?? '???')
  kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
}
console.log('\ntipos de evento:')
for (const [kind, count] of [...kinds.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(5)}  ${kind}`)
}

for (const [label, pattern] of [
  ['usage', /usage/i],
  ['model', /"model"/i],
  ['request', /request/i],
]) {
  const hit = events.find((event) => pattern.test(JSON.stringify(event)))
  console.log(`\n--- primeiro evento com "${label}" ---`)
  const text = JSON.stringify(hit, null, 2)
  console.log(text === undefined ? 'nenhum' : text.slice(0, 1400))
}
