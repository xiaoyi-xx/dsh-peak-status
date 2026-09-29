/**
 * Build: copy the plain-JS sources from src/ into the published lib/.
 * Zero dependencies — the plugin halves are plain JavaScript on purpose.
 *
 * `src/economy/` is copied as a tree, so the host half stays split into
 * readable modules instead of one long entry file.
 */
import { copyFile, cp, mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const srcDir = join(root, 'src')
const libDir = join(root, 'lib')

await mkdir(libDir, { recursive: true })
for (const entry of await readdir(srcDir, { withFileTypes: true })) {
  const from = join(srcDir, entry.name)
  const to = join(libDir, entry.name)
  if (entry.isDirectory()) {
    await cp(from, to, { recursive: true })
    console.log(`built lib/${entry.name}/`)
    continue
  }
  if (entry.isFile() && entry.name.endsWith('.js')) {
    await copyFile(from, to)
    console.log(`built lib/${entry.name}`)
  }
}
