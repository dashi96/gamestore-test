import pg from 'pg'
import { config } from './config.ts'

// Деньги храним в целых рублях, но numeric из pg всё равно приходит строкой —
// на всякий случай приводим int8 к числу.
pg.types.setTypeParser(20, (v) => Number(v))

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 })

export type Client = pg.PoolClient

/** Транзакция с автоматическим rollback: бросили — откатили. */
export async function tx<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

export async function waitForDb(attempts = 30): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('select 1')
      return
    } catch (err) {
      if (i === attempts) throw err
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
}
