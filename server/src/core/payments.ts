import type { Client } from '../lib/db.ts'
import { pool, tx } from '../lib/db.ts'
import { badRequest } from '../lib/errors.ts'
import * as events from './events.ts'
import { lockOrder, setStatus, type Order, type OrderStatus } from './orders.ts'
import * as promo from './promo.ts'
import * as reservations from './reservations.ts'

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

/**
 * Статусы, из которых оплата ещё имеет смысл.
 *
 * `payment_failed` и `reservation_expired` здесь не опечатка: вебхуки приходят
 * не по порядку, и последовательности failed → paid и «бронь сняли → пришла
 * оплата» реальны. Деньги пришли — товар надо выдать, поэтому paid перебивает и
 * ранее записанный отказ, и снятую бронь.
 */
const PAYABLE: OrderStatus[] = ['created', 'awaiting_payment', 'payment_failed', 'reservation_expired']

/** @returns true — событие применено; false — заказа ещё нет, оставляем на потом. */
export async function processEvent(client: Client, event: EventRow): Promise<boolean> {
  const order = await lockOrder(client, event.order_id)
  if (!order) return false

  let note = 'noop'

  if (event.status === 'failed') {
    // Оплата, пришедшая после успешной, не отменяет её: paid сильнее failed.
    if (order.status === 'created' || order.status === 'awaiting_payment') {
      await promo.release(client, order.id)
      // Товар возвращается в продажу сразу: держать его за неоплаченным заказом
      // незачем, а пришедшее позже paid разберётся перезахватом.
      const offerId = await reservations.release(client, order.id, 'payment_failed')
      await setStatus(client, order.id, 'payment_failed', 'webhook_failed')
      if (offerId) await events.emit(client, offerId)
      note = 'payment_failed'
    }
  } else if (PAYABLE.includes(order.status)) {
    const expected = order.total_rub
    if (event.amount_rub !== null && event.amount_rub !== expected) {
      // Сумму считает сервер; платить меньше, чем в заказе, нельзя.
      note = `amount_mismatch:${event.amount_rub}!=${expected}`
    } else {
      note = await settle(client, order)
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

/**
 * Оплата принята: единица переходит из брони в продажу, заказ уходит в выдачу.
 * Заказ уже под блокировкой строки.
 */
async function settle(client: Client, order: Order): Promise<string> {
  const settled = await reservations.settlePaid(client, order)
  if (!settled.ok) {
    // Оплата пришла, а товара нет: бронь сняли, и свободных единиц не осталось.
    // Состояние восстановимое — воркер повторит попытку, когда остаток пополнят.
    await setStatus(client, order.id, 'out_of_stock', 'no_stock_on_late_payment')
    return 'paid_no_stock'
  }

  const revived = order.status === 'payment_failed' || order.status === 'reservation_expired'
  // Забрать промокод обратно можно только там, где его вернули в лимит, а
  // возвращает его один-единственный переход — отказ оплаты. Истёкшая бронь
  // промокод не трогает, поэтому после неё `reclaim` списал бы лимит второй раз
  // за один заказ. Если лимит за это время выбрали другие, заказ всё равно
  // выдаётся по своей зафиксированной сумме: обязательство перед оплатившим
  // клиентом важнее счётчика промокода.
  const promoBack =
    order.status === 'payment_failed' && order.promo_code ? await promo.reclaim(client, order) : true

  await setStatus(client, order.id, 'paid', promoBack ? null : 'promo_limit_exceeded_on_revival')
  await enqueueDelivery(client, order.id)
  await events.emit(client, settled.offerId)

  if (settled.reclaimed) return 'paid_reclaimed'
  return revived ? 'paid_after_failed' : 'paid'
}

/**
 * Ставим заказ в очередь выдачи. Повторный вызов не создаёт вторую задачу.
 * Поставщик берётся у продавца: код выдаёт тот, у кого товар лежал на складе.
 */
export async function enqueueDelivery(client: Client, orderId: string) {
  await client.query(
    `insert into delivery_jobs (order_id, provider)
     select o.id, coalesce(s.provider_id, 'a')
       from orders o
       left join offers f on f.id = o.offer_id
       left join sellers s on s.id = f.seller_id
      where o.id = $1
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

/**
 * Оплаченные заказы, которым не досталось единицы склада. Повторяем перезахват,
 * пока не получится: пополнили остаток — заказ сам поедет дальше.
 *
 * Заказы, у которых единица уже продана, а кода нет (пустой поставщик из первого
 * этапа), сюда не попадают: их обслуживает очередь выдачи.
 */
export async function recoverStuck(limit = 20): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `select o.id from orders o
      where o.status = 'out_of_stock'
        and o.offer_id is not null
        and not exists (select 1 from stock_units u where u.sold_order_id = o.id)
      order by o.updated_at
      limit $1`,
    [limit],
  )

  let recovered = 0
  for (const row of rows) {
    const ok = await tx(async (client) => {
      const order = await lockOrder(client, row.id)
      if (!order || order.status !== 'out_of_stock') return false
      const settled = await reservations.settlePaid(client, order)
      if (!settled.ok) return false
      await setStatus(client, order.id, 'paid', 'stock_recovered')
      await enqueueDelivery(client, order.id)
      await events.emit(client, settled.offerId)
      return true
    })
    if (ok) recovered++
  }
  return recovered
}
