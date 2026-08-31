import { claimJob, runJob } from './core/delivery.ts'
import { processParked } from './core/payments.ts'
import { pool, tx, waitForDb } from './lib/db.ts'

const IDLE_MS = 200
const PARKED_EVERY_MS = 1000

const workerId = process.env.HOSTNAME ?? String(process.pid)
const log = (message: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ worker: workerId, message, ...extra }))

let running = true

/**
 * Воркер выдачи. Задачи забираются через FOR UPDATE SKIP LOCKED, поэтому
 * несколько экземпляров (--scale worker=3) работают параллельно и не пересекаются.
 */
async function deliveryLoop() {
  while (running) {
    try {
      const job = await tx((client) => claimJob(client))
      if (!job) {
        await sleep(IDLE_MS)
        continue
      }
      const result = await runJob(job)
      log('job', { order: job.order_id, provider: job.provider, attempt: job.attempts, result })
    } catch (err) {
      log('job_error', { error: String(err) })
      await sleep(1000)
    }
  }
}

/** Вебхуки, пришедшие раньше своих заказов, ждут здесь. */
async function parkedLoop() {
  while (running) {
    try {
      const applied = await processParked()
      if (applied) log('parked_events_applied', { count: applied })
    } catch (err) {
      log('parked_error', { error: String(err) })
    }
    await sleep(PARKED_EVERY_MS)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

await waitForDb()
log('started')

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    running = false
    await pool.end().catch(() => {})
    process.exit(0)
  })
}

await Promise.all([deliveryLoop(), parkedLoop()])
