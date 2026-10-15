/** Diagnostico: qual via do Node descomprime TODOS os frames zstd concatenados. */
import { readdir, readFile, stat } from 'node:fs/promises'
import { createZstdDecompress, zstdDecompressSync, constants } from 'node:zlib'
import { join } from 'node:path'
import { homedir } from 'node:os'

const root = join(homedir(), '.dsh', 'sessions')
let target = null
for (const workspace of await readdir(root, { withFileTypes: true })) {
  if (!workspace.isDirectory()) continue
  for (const session of await readdir(join(root, workspace.name), { withFileTypes: true })) {
    if (!session.isDirectory()) continue
    const path = join(root, workspace.name, session.name, 'session.v3.jsonl.zstd')
    const info = await stat(path).catch(() => null)
    if (info !== null && info.size > 1000) target = path
  }
}
const raw = await readFile(target)
console.log(`arquivo: ${String(raw.length)} bytes\n`)

// Via 1: sincrona
console.log(`[1] zstdDecompressSync          -> ${String(zstdDecompressSync(raw).length)} bytes`)

// Via 2: fluxo, modo continuo explicito
for (const params of [
  ['padrao', undefined],
  ['withChecksum+multi', { [constants.ZSTD_d_windowLogMax]: 31 }],
]) {
  const [label, options] = params
  const out = await new Promise((resolve) => {
    const chunks = []
    const stream = options === undefined ? createZstdDecompress() : createZstdDecompress(options)
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('error', (error) => resolve(`erro: ${error.message}`))
    stream.on('end', () => resolve(Buffer.concat(chunks).length))
    stream.end(raw)
  })
  console.log(`[2] createZstdDecompress ${label.padEnd(20)} -> ${String(out)} bytes`)
}

// Via 3: streams.pipeline com iteracao
try {
  const { pipeline } = await import('node:stream/promises')
  const { Readable } = await import('node:stream')
  const chunks = []
  await pipeline(Readable.from([raw]), createZstdDecompress(), async function* (source) {
    for await (const chunk of source) chunks.push(chunk)
  })
  console.log(`[3] pipeline                    -> ${String(Buffer.concat(chunks).length)} bytes`)
} catch (error) {
  console.log(`[3] pipeline                    -> erro: ${error.message}`)
}

// Via 4: quantos frames cada via realmente entregou
const text = zstdDecompressSync(raw).toString('utf8')
console.log(`\nlinhas na via sincrona: ${String(text.split('\n').filter((line) => line.trim()).length)}`)
