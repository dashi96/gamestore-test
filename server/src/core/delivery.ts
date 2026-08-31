import { config, type ProviderId } from '../lib/config.ts'
import type { Client } from '../lib/db.ts'
import { tx } from '../lib/db.ts'
import { requestIdFor } from '../lib/ids.ts'
import { lockOrder, setStatus } from './orders.ts'
import { issue } from './providers.ts'

export type Job = {
  order_id: string
  provider: ProviderId
  attempts: number
  next_run_at: Date
  last_error: string | null
}

const LOCK_TIMEOUT_SEC = 30

/**
 * Забираем задачу из очереди. SKIP LOCKED — поэтому несколько воркеров
 * (docker compose up --scale worker=3) разбирают очередь без пересечений,
 * а зависший воркер не держит задачу дольше LOCK_TIMEOUT_SEC.
 */
export async function claimJob(client: Client): Promise<Job | null> {
  const { rows } = await client.query<Job>(
    `update delivery_jobs
        set locked_at = now(), attempts = attempts + 1
      where order_id = (
        select order_id from delivery_jobs
         where next_run_at <= now()
           and (locked_at is null or locked_at < now() - interval '${LOCK_TIMEOUT_SEC} seconds')
         order by next_run_at
         for update skip locked
         limit 1
      )
      returning *`,
  )
  return rows[0] ?? null
}

export type StepResult =
  | 'delivered'
  | 'already_delivered'
  | 'switched_provider'
  | 'out_of_stock'
  | 'retry'
  | 'delivery_failed'
  | 'skipped'

/** Одна попытка выдачи по задаче. Вызывается воркером и админской перевыдачей. */
export async function runJob(job: Job): Promise<StepResult> {
  const prepared = await tx(async (client) => {
    const order = await lockOrder(client, job.order_id)
    if (!order) {
      await dropJob(client, job.order_id)
      return null
    }

    // Кто-то уже выдал код по этому заказу — просто приводим статус в порядок.
    const existing = await client.query('select 1 from deliveries where order_id = $1', [job.order_id])
    if (existing.rowCount) {
      if (order.status !== 'delivered') await setStatus(client, order.id, 'delivered', null)
      await dropJob(client, job.order_id)
      return null
    }

    const deliverable = ['paid', 'delivering', 'out_of_stock', 'delivery_failed'].includes(order.status)
    if (!deliverable) {
      // created (оплаты ещё нет) или payment_failed — выдавать нечего.
      await dropJob(client, job.order_id)
      return null
    }

    await setStatus(client, order.id, 'delivering', null)
    return { sku: order.sku }
  })

  if (!prepared) return 'skipped'

  const requestId = requestIdFor(job.order_id, job.provider)
  const outcome = await issue(job.provider, {
    request_id: requestId,
    sku: prepared.sku,
    order_id: job.order_id,
  })

  if (outcome.kind === 'ok') {
    return tx(async (client) => {
      await lockOrder(client, job.order_id)
      const { rowCount } = await client.query(
        `insert into deliveries (order_id, provider, request_id, code)
         values ($1, $2, $3, $4)
         on conflict (order_id) do nothing`,
        [job.order_id, job.provider, requestId, outcome.code],
      )
      await setStatus(client, job.order_id, 'delivered', null)
      await dropJob(client, job.order_id)
      // rowCount === 0 значит выдачу успел записать другой воркер. Второго кода
      // при этом не появилось: request_id детерминирован, поставщик вернул тот же.
      return rowCount ? 'delivered' : 'already_delivered'
    })
  }

  if (outcome.kind === 'out_of_stock') {
    return tx(async (client) => {
      await lockOrder(client, job.order_id)
      if (job.provider === 'a') {
        // Однозначный отказ — переключение на резервного поставщика безопасно.
        await client.query(
          `update delivery_jobs
              set provider = 'b', attempts = 0, locked_at = null,
                  next_run_at = now(), last_error = 'a:out_of_stock'
            where order_id = $1`,
          [job.order_id],
        )
        return 'switched_provider'
      }
      // Пусто у обоих: заказ оплачен, кода нет. Состояние восстановимое —
      // после пополнения остатка задача сама возьмётся снова.
      await setStatus(client, job.order_id, 'out_of_stock', 'both_providers_out_of_stock')
      await client.query(
        `update delivery_jobs
            set provider = 'a', attempts = 0, locked_at = null,
                next_run_at = now() + interval '10 seconds', last_error = 'out_of_stock'
          where order_id = $1`,
        [job.order_id],
      )
      return 'out_of_stock'
    })
  }

  // Неоднозначный исход. Поставщика НЕ меняем: он мог уже выдать код, а ответ
  // не дошёл. Повторяем к нему же с тем же request_id — вернётся тот же код.
  return tx(async (client) => {
    await lockOrder(client, job.order_id)
    const exhausted = job.attempts >= config.maxDeliveryAttempts
    const backoffSec = exhausted ? 30 : Math.min(2 ** job.attempts, 15)
    await client.query(
      `update delivery_jobs
          set locked_at = null,
              next_run_at = now() + ($2 || ' seconds')::interval,
              last_error = $3
        where order_id = $1`,
      [job.order_id, backoffSec, `${job.provider}:${outcome.error}`],
    )
    if (exhausted) {
      await setStatus(client, job.order_id, 'delivery_failed', outcome.error)
      return 'delivery_failed'
    }
    return 'retry'
  })
}

const dropJob = (client: Client, orderId: string) =>
  client.query('delete from delivery_jobs where order_id = $1', [orderId])

/**
 * Ручная перевыдача из админки. Идемпотентна: если код уже выдан, ничего не
 * произойдёт — runJob упрётся в существующую строку deliveries.
 */
export async function requestRedelivery(orderId: string) {
  return tx(async (client) => {
    const order = await lockOrder(client, orderId)
    if (!order) return { ok: false, reason: 'order_not_found' as const }
    const delivered = await client.query('select code from deliveries where order_id = $1', [orderId])
    if (delivered.rows[0]) return { ok: true, alreadyDelivered: true, code: delivered.rows[0].code }

    await client.query(
      `insert into delivery_jobs (order_id, provider, attempts, next_run_at, locked_at)
       values ($1, 'a', 0, now(), null)
       on conflict (order_id) do update
         set provider = 'a', attempts = 0, next_run_at = now(), locked_at = null`,
      [orderId],
    )
    return { ok: true, alreadyDelivered: false }
  })
}
