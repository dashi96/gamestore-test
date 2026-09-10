import { config } from '../lib/config.ts'
import type { Client } from '../lib/db.ts'
import { pool, tx } from '../lib/db.ts'
import * as events from './events.ts'
import { lockOrder, setStatus } from './orders.ts'
import { FREE_UNIT, soldUnit } from './stock.ts'

/**
 * Единственная точка входа во все переходы брони: захват, продажа, снятие,
 * развёртка просрочки. Другого места, где встречаются блокировки заказа и
 * единицы склада, в коде нет — и порядок здесь всегда один:
 *
 *   СНАЧАЛА строка заказа, ПОТОМ строка единицы склада.
 *
 * Держится на этом две вещи: отсутствие взаимных блокировок и корректность
 * двухшагового захвата.
 */

export type Reservation = {
  id: number
  unit_id: number
  order_id: string
  price_rub: number
  expires_at: Date
  hard_expires_at: Date
  released_at: Date | null
  release_reason: string | null
}

/**
 * Захват свободной единицы под заказ.
 *
 * Ноль строк в ответе означает «единиц не осталось» — победитель гонки уже есть.
 * Корректность держится на одном условии: строка `stock_units` берётся под
 * `for update` ПЕРВОЙ. Поэтому проверка «нет активной брони» не может устареть
 * между чтением и вставкой — конкурент, способный вставить бронь на эту единицу,
 * обязан сначала взять ту же строку и будет ждать. `skip locked` уводит его на
 * следующую свободную единицу вместо ожидания, а когда свободных нет, он честно
 * получает ноль строк.
 *
 * Уникальный индекс `reservations_unit_active` остаётся страховкой: если это
 * рассуждение когда-нибудь окажется неверным, вставка упадёт, а не создаст
 * вторую бронь на одну единицу.
 *
 * Цена берётся из базы в момент захвата, а не читается заранее: между чтением и
 * записью нет промежутка, в который она могла бы измениться.
 */
export type Claim = { reservation: Reservation; offerId: number; priceRub: number }

/**
 * Захват идёт одним запросом. Внутренняя выборка блокирует строку склада с
 * `skip locked`, внешний UPDATE ставит на неё держателя — и всё условие
 * доступности при этом относится к самой строке `stock_units`, поэтому
 * повторная проверка при взятии блокировки работает. Конкурент либо ждёт на
 * блокировке, либо уходит на следующую свободную единицу, либо честно получает
 * ноль строк, если свободных больше нет.
 *
 * Цена берётся здесь же, в том же снимке, что и единица: между выбором единицы
 * и фиксацией цены нет промежутка, в который она могла бы измениться.
 */
const claimSql = (source: string) => `
  with picked as (
    update stock_units set held_by_order = $2
     where id = (
       select u.id from stock_units u join offers o on o.id = u.offer_id
        where ${source} and ${FREE_UNIT}
        order by o.price_rub, o.id, u.id
        for update of u skip locked
        limit 1
     )
    returning id as unit_id, offer_id
  ),
  held as (
    insert into reservations (unit_id, order_id, price_rub, expires_at, hard_expires_at)
    select p.unit_id, $2, o.price_rub,
           now() + ($3 || ' seconds')::interval,
           now() + ($4 || ' seconds')::interval
      from picked p join offers o on o.id = p.offer_id
    returning *
  )
  select held.*, picked.offer_id from held, picked`

type ClaimRow = Reservation & { offer_id: number }

async function runClaim(client: Client, sql: string, key: number | string, orderId: string) {
  const { rows } = await client.query<ClaimRow>(sql, [
    key,
    orderId,
    config.reservationTtlSec,
    config.reservationHardTtlSec,
  ])
  const row = rows[0]
  if (!row) return null
  return { reservation: row, offerId: row.offer_id, priceRub: row.price_rub }
}

/** Продавец выбран покупателем: берём единицу только у него и никуда не уходим. */
export const claimFromOffer = (client: Client, offerId: number, orderId: string) =>
  runClaim(client, claimSql('o.id = $1'), offerId, orderId)

/**
 * Продавец не выбран (путь первого этапа, заказ по товару). Единица берётся из
 * любого предложения этого товара, начиная с самого дешёвого. Выбирать
 * предложение заранее нельзя: десять параллельных заказов упёрлись бы в одно и
 * то же, а у соседнего продавца товар лежал бы свободным.
 */
export const claimBySku = (client: Client, sku: string, orderId: string) =>
  runClaim(client, claimSql('o.sku = $1'), sku, orderId)

export type ActiveReservation = Reservation & { offer_id: number; code_ref: string }

export async function active(client: Client | typeof pool, orderId: string) {
  const { rows } = await client.query<ActiveReservation>(
    `select r.*, u.offer_id, u.code_ref
       from reservations r join stock_units u on u.id = r.unit_id
      where r.order_id = $1 and r.released_at is null`,
    [orderId],
  )
  return rows[0] ?? null
}

/** @returns id предложения, чтобы вызывающий отправил событие витрине. */
export async function release(
  client: Client,
  orderId: string,
  reason: string,
): Promise<number | null> {
  const { rows } = await client.query<{ offer_id: number }>(
    `with done as (
       update reservations set released_at = now(), release_reason = $2
        where order_id = $1 and released_at is null
       returning unit_id
     ),
     freed as (
       update stock_units set held_by_order = null
        where id in (select unit_id from done)
       returning offer_id
     )
     select offer_id from freed`,
    [orderId, reason],
  )
  return rows[0]?.offer_id ?? null
}

export type Settlement =
  | { ok: true; unitId: number; offerId: number; reclaimed: boolean }
  | { ok: false; reason: 'no_stock' }

/**
 * Оплата пришла: единица переходит из брони в продажу. Вызывается под уже взятой
 * блокировкой заказа.
 *
 * Ветка перезахвата — та самая защита второго уровня. Брони может не быть по
 * двум причинам: она истекла, пока платёж был в полёте, либо её сняли по отказу,
 * который позже перекрыло пришедшее `paid`. Деньги в обоих случаях пришли, и
 * оставлять покупателя без товара нельзя, поэтому берём любую свободную единицу
 * того же предложения по цене, зафиксированной в снятой броне.
 */
export async function settlePaid(
  client: Client,
  order: { id: string; offer_id: number | null },
): Promise<Settlement> {
  // Идемпотентность: повторный вызов не должен захватывать вторую единицу.
  const already = await soldUnit(client, order.id)
  if (already) {
    return { ok: true, unitId: already.id, offerId: already.offer_id, reclaimed: false }
  }

  const held = await active(client, order.id)
  if (held) {
    await sell(client, held.unit_id, order.id)
    return { ok: true, unitId: held.unit_id, offerId: held.offer_id, reclaimed: false }
  }

  if (!order.offer_id) return { ok: false, reason: 'no_stock' }
  // Перезахват идёт у того же продавца: цена уже зафиксирована, и уводить
  // оплаченный заказ к другому продавцу с другой ценой было бы подменой сделки.
  const fresh = await claimFromOffer(client, order.offer_id, order.id)
  if (!fresh) return { ok: false, reason: 'no_stock' }
  await sell(client, fresh.reservation.unit_id, order.id)
  return { ok: true, unitId: fresh.reservation.unit_id, offerId: order.offer_id, reclaimed: true }
}

/**
 * Продажа единицы. Бронь при этом закрывается: «активная бронь» должна означать
 * «держится, ещё не продана», иначе условия развёртки становятся запутанными.
 */
async function sell(client: Client, unitId: number, orderId: string) {
  await client.query(
    `update stock_units
        set sold_order_id = $2, held_by_order = null
      where id = $1 and sold_order_id is null`,
    [unitId, orderId],
  )
  // Бронь закрывается: «активная бронь» должна означать «держится, ещё не
  // продана», иначе условия развёртки становятся запутанными.
  await client.query(
    `update reservations set released_at = now(), release_reason = 'sold'
      where order_id = $1 and released_at is null`,
    [orderId],
  )
}

/**
 * Нажали «оплатить». Заказ уходит в `awaiting_payment`, и развёртка перестаёт
 * смотреть на обычный срок брони — только на потолок `hard_expires_at`. Это
 * основной уровень защиты от «бронь истекла, пока платёж был в полёте».
 */
export async function markAwaitingPayment(orderId: string) {
  return tx(async (client) => {
    const order = await lockOrder(client, orderId)
    if (!order) return { found: false as const }
    if (order.status === 'created') {
      await setStatus(client, orderId, 'awaiting_payment')
      return { found: true as const, status: 'awaiting_payment' as const }
    }
    return { found: true as const, status: order.status }
  })
}

/** Условие «бронь пора снимать». Одно и то же в выборке и в перепроверке. */
const DUE = `
  r.released_at is null
  and ( (o.status = 'created'          and r.expires_at      <= now())
     or (o.status = 'awaiting_payment' and r.hard_expires_at <= now())
     or  o.status in ('payment_failed','reservation_expired') )`

/**
 * Развёртка просроченных броней — единственное, что возвращает единицы в продажу.
 *
 * Ключевое место: условие перепроверяется ПОСЛЕ взятия блокировки заказа. Между
 * выборкой и блокировкой заказ мог стать `paid`, и тогда снимать бронь нельзя ни
 * в каком случае. Проверка идёт запросом к базе, а не сравнением дат в JS, чтобы
 * не зависеть от расхождения часов приложения и базы.
 */
export async function sweep(limit = 100): Promise<number> {
  const { rows } = await pool.query<{ id: number; order_id: string }>(
    `select r.id, r.order_id
       from reservations r join orders o on o.id = r.order_id
      where ${DUE}
      order by r.expires_at
      limit $1`,
    [limit],
  )

  let released = 0
  for (const row of rows) {
    const done = await tx(async (client) => {
      const order = await lockOrder(client, row.order_id)
      if (!order) return false

      const { rows: check } = await client.query<{ due: boolean }>(
        `select exists (
           select 1 from reservations r join orders o on o.id = r.order_id
            where r.id = $1 and ${DUE}
         ) as due`,
        [row.id],
      )
      if (!check[0]?.due) return false

      const expired = order.status === 'created' || order.status === 'awaiting_payment'
      const reason = expired ? 'expired' : `released_after_${order.status}`
      const offerId = await release(client, order.id, reason)
      if (expired) await setStatus(client, order.id, 'reservation_expired', reason)
      if (offerId) await events.emit(client, offerId)
      return true
    })
    if (done) released++
  }
  return released
}
