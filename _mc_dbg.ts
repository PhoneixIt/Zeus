import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalObservationProvider } from './packages/observation/local.ts'
const root = mkdtempSync(join(tmpdir(), 'dbg-'))
const src = join(root, 'src'); mkdirSync(src, { recursive: true })
for (const n of ['a.ts','b.ts','c.ts','d.ts','e.ts']) writeFileSync(join(src,n), 'x'.repeat(50), 'utf8')
const out = mkdtempSync(join(root,'out-'))
mkdirSync(out, { recursive: true })
const obs = await new LocalObservationProvider().observe({ root } as never)
const w = (obs as unknown as {world: {entries: {path:string;depth:number;kind:string;relative:string}[]}}).world
console.log('entries for src children:')
for (const e of w.entries.filter(e=>e.path.includes('src'))) console.log('  depth',e.depth,e.kind,e.relative)
