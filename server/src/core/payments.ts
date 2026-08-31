import type { Client } from '../lib/db.ts'
import { pool, tx } from '../lib/db.ts'
import { badRequest } from '../lib/errors.ts'
import { lockOrder, setStatus } from './orders.ts'
import * as promo from './promo.ts'

export type WebhookBody = {
  event_id: string
  order_id: string
  status: 'paid' | 'failed'
  amount?: number
  currency?: string
  created_at?: string
}

export type EventRow = {
  event_id: string
  order_id: string
  status: string
  amount_rub: number | null
  currency: string | null
  payload: WebhookBody
}

export type HandleResult = 'accepted' | 'duplicate' | 'parked'

export function parseWebhook(raw: unknown): WebhookBody {
  const body = raw as Partial<WebhookBody> | null
  if (!body?.event_id || !body.order_id) throw badRequest('bad_webhook', 'event_id и order_id обязательны')
  if (body.status !== 'paid' && body.status !== 'failed') throw badRequest('bad_status')
  return {
    event_id: String(body.event_id),
    order_id: String(body.order_id),
    status: body.status,
    amount: body.amount === undefined ? undefined : Number(body.amount),
    currency: body.currency,
    created_at: body.created_at,
  }
}

/**
 * Приём вебхука. Всё в одной короткой транзакции:
 *
 *  1. INSERT ... ON CONFLICT (event_id) DO NOTHING — дедупликация повторной
 *     доставки. Ноль вставленных строк означает «это ретрай», выходим сразу,
 *     ничего не меняя. 50 параллельных вебхуков одного события: один вставил,
 *     остальные 49 подождали на блокировке ключа и ушли ни с чем.
 *  2. Обработка под блокировкой строки заказа.
 *
 * Заказа может ещё не быть (вебхук обогнал создание) — тогда событие остаётся
 * с processed_at = NULL и его подберёт воркер. Ответ всё равно 200: платёжке
 * незачем ретраить то, что мы уже приняли.
 */
export async function handleWebhook(body: WebhookBody): Promise<HandleResult> {
  return tx(async (client) => {
    const { rows } = await client.query<EventRow>(
      `insert into payment_events (event_id, order_id, status, amount_rub, currency, payload)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (event_id) do nothing
       returning *`,
      [body.event_id, body.order_id, body.status, body.amount ?? null, body.currency ?? null, body],
    )
    const event = rows[0]
    if (!event) return 'duplicate'
    return (await processEvent(client, event)) ? 'accepted' : 'parked'
  })
}

/** @returns true — событие применено; false — заказа ещё нет, оставляем на потом. */
export async function processEvent(client: Client, event: EventRow): Promise<boolean> {
  const order = await lockOrder(client, event.order_id)
  if (!order) return false

  let note = 'noop'

  if (event.status === 'failed') {
    // Оплата, пришедшая после успешной, не отменяет её: paid сильнее failed.
    if (order.status === 'created') {
      await promo.release(client, order.id)
      await setStatus(client, order.id, 'payment_failed', 'webhook_failed')
      note = 'payment_failed'
    }
  } else if (order.status === 'created') {
    const expected = order.total_rub
    if (event.amount_rub !== null && event.amount_rub !== expected) {
      // Сумму считает сервер; платить меньше, чем в заказе, нельзя.
      note = `amount_mismatch:${event.amount_rub}!=${expected}`
    } else {
      await setStatus(client, order.id, 'paid', null)
      await enqueueDelivery(client, order.id)
      note = 'paid'
    }
  }
  // Все прочие статусы (paid/delivering/delivered/...) — заказ уже дальше по
  // жизненному циклу, повтор оплаты его не трогает.

  await client.query('update payment_events set processed_at = now(), note = $2 where event_id = $1', [
    event.event_id,
    note,
  ])
  return true
}

/** Ставим заказ в очередь выдачи. Повторный вызов не создаёт вторую задачу. */
export async function enqueueDelivery(client: Client, orderId: string) {
  await client.query(
    `insert into delivery_jobs (order_id) values ($1)
     on conflict (order_id) do nothing`,
    [orderId],
  )
}

/**
 * Разбор «осиротевших» событий: вебхук пришёл раньше создания заказа или не по
 * порядку. Вызывается воркером по таймеру и один раз сразу после создания заказа.
 */
export async function processParked(orderId?: string): Promise<number> {
  const { rows } = await pool.query<EventRow>(
    `select * from payment_events
      where processed_at is null ${orderId ? 'and order_id = $1' : ''}
      order by received_at
      limit 100`,
    orderId ? [orderId] : [],
  )

  let applied = 0
  for (const event of rows) {
    const done = await tx(async (client) => {
      // Перечитываем под блокировкой: событие мог забрать другой воркер.
      const fresh = await client.query<EventRow>(
        'select * from payment_events where event_id = $1 and processed_at is null for update skip locked',
        [event.event_id],
      )
      if (!fresh.rows[0]) return false
      return processEvent(client, fresh.rows[0])
    })
    if (done) applied++
  }
  return applied
}
