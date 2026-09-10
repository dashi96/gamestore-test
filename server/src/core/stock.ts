import type { Client } from '../lib/db.ts'
import { pool } from '../lib/db.ts'
import type { ProviderId } from '../lib/config.ts'

export type Offer = {
  id: number
  sku: string
  seller_id: string
  seller_name: string
  provider_id: ProviderId
  price_rub: number
}

/**
 * Свободна единица, которая не продана и никем не держится. Условие намеренно
 * целиком по строке `stock_units`: только тогда `SELECT ... FOR UPDATE`
 * перепроверит его при взятии блокировки. Проверка через таблицу броней этим
 * свойством не обладает и пропускает двойной захват.
 *
 * Срок брони в расчёт не берётся: освобождает бронь только развёртка в воркере.
 * Плата — единица занята лишние доли секунды после истечения отсчёта.
 */
export const FREE_UNIT = 'u.sold_order_id is null and u.held_by_order is null'

const OFFER_SQL = `
  select o.id, o.sku, o.seller_id, s.name as seller_name, s.provider_id, o.price_rub
    from offers o join sellers s on s.id = o.seller_id`

/**
 * Цена, по которой заказ по товару действительно будет создан: самое дешёвое
 * предложение со свободной единицей. Тот же порядок, что и у захвата по `sku`,
 * поэтому предпросмотр скидки совпадает с тем, что спишется.
 */
export async function priceForSku(sku: string) {
  const { rows } = await pool.query<{ price_rub: number }>(
    `select o.price_rub
       from offers o
      where o.sku = $1
        and exists (select 1 from stock_units u where u.offer_id = o.id and ${FREE_UNIT})
      order by o.price_rub, o.id
      limit 1`,
    [sku],
  )
  return rows[0]?.price_rub ?? null
}

export async function getOffer(client: Client | typeof pool, offerId: number) {
  const { rows } = await client.query<Offer>(`${OFFER_SQL} where o.id = $1`, [offerId])
  return rows[0] ?? null
}

/**
 * Что предложить проигравшему гонку за последней единицей. Пункт 2.2 ТЗ требует
 * «предложение другого продавца», поэтому в каталоге у каждого товара их минимум два.
 */
export async function alternatives(sku: string, excludeOfferId: number) {
  const { rows } = await pool.query<Offer & { available: number }>(
    `select o.id, o.sku, o.seller_id, s.name as seller_name, s.provider_id, o.price_rub,
            a.available
       from offers o
       join sellers s on s.id = o.seller_id
       join lateral (select count(*)::int as available from stock_units u
                      where u.offer_id = o.id and ${FREE_UNIT}) a on a.available > 0
      where o.sku = $1 and o.id <> $2
      order by o.price_rub, o.id
      limit 5`,
    [sku, excludeOfferId],
  )
  return rows
}

/** Единица, закреплённая за заказом продажей: из неё берётся код у поставщика. */
export async function soldUnit(client: Client, orderId: string) {
  const { rows } = await client.query<{ id: number; code_ref: string; offer_id: number }>(
    'select id, code_ref, offer_id from stock_units where sold_order_id = $1',
    [orderId],
  )
  return rows[0] ?? null
}
