import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { pool, tx, waitForDb } from './lib/db.ts'

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations')

await waitForDb()
await pool.query(`create table if not exists schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
)`)

const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()
const { rows } = await pool.query<{ name: string }>('select name from schema_migrations')
const applied = new Set(rows.map((r) => r.name))

for (const file of files) {
  if (applied.has(file)) {
    console.log(`= ${file}`)
    continue
  }
  const sql = await readFile(join(migrationsDir, file), 'utf8')
  await tx(async (client) => {
    await client.query(sql)
    await client.query('insert into schema_migrations (name) values ($1)', [file])
  })
  console.log(`+ ${file}`)
}

await pool.end()
console.log('миграции применены')
