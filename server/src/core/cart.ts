import { pool } from '../lib/db.ts'
import { badRequest } from '../lib/errors.ts'
import { currentSeq, offerStatesByIds, type OfferState } from './events.ts'

/**
 * Корзина.
 *
 * Цены в ней нет — есть только та, которую покупатель видел. Сумму всегда
 * считает `offers`, поэтому устареть ей негде, и требование «новая цена видна до
 * оплаты, а не после» выполняется само собой: корзина физически не способна
 * показать старую цену как действующую.
 *
 * Хранится на сервере, а не в `localStorage`, по той же причине: в браузере
 * цена лежала бы в данных, которые правит покупатель, между вкладками сама не
 * синхронизировалась бы, а после закрытия вкладки оставалась бы устаревшей.
 * Проверять всё равно пришлось бы на сервере — то есть механизма было бы два,
 * а гарантии ни одного.
 */

export type CartItem = OfferState & {
  /** Цена на момент добавления. Показ, а не расчёт. */
  price_seen_rub: number
  price_changed: boolean
  added_at: Date
}

export type Cart = {
  seq: number
  items: CartItem[]
  /** Сумма по действующим ценам, а не по увиденным. */
  total_rub: number
}

export async function getCart(cartId: string | null): Promise<Cart> {
  if (!cartId) return { seq: await currentSeq(), items: [], total_rub: 0 }

  const { rows } = await pool.query<{ offer_id: number; price_seen_rub: number; added_at: Date }>(
    'select offer_id, price_seen_rub, added_at from cart_items where cart_id = $1 order by added_at',
    [cartId],
  )
  // Номер журнала — до чтения состояний: снимок корзины тогда не старше номера,
  // и досылка с него ничего не пропустит.
  const seq = await currentSeq()
  const states = await offerStatesByIds(rows.map((r) => r.offer_id))
  const byId = new Map(states.map((state) => [state.offer_id, state]))

  const items = rows.flatMap((row) => {
    const state = byId.get(row.offer_id)
    if (!state) return []
    return [
      {
        ...state,
        seq,
        price_seen_rub: row.price_seen_rub,
        price_changed: state.price_rub !== row.price_seen_rub,
        added_at: row.added_at,
      },
    ]
  })

  return { seq, items, total_rub: items.reduce((sum, item) => sum + item.price_rub, 0) }
}

/**
 * Положить предложение в корзину. Повторное добавление обновляет увиденную цену:
 * покупатель, который кладёт товар снова, видит уже новую цену — значит, она для
 * него и есть увиденная.
 */
export async function addItem(cartId: string, offerId: number) {
  const { rowCount } = await pool.query(
    `insert into cart_items (cart_id, offer_id, price_seen_rub)
     select $1, o.id, o.price_rub from offers o where o.id = $2
     on conflict (cart_id, offer_id)
       do update set price_seen_rub = excluded.price_seen_rub, added_at = now()`,
    [cartId, offerId],
  )
  if (!rowCount) throw badRequest('unknown_offer', 'Такого предложения нет')
}

export const removeItem = (cartId: string, offerId: number) =>
  pool.query('delete from cart_items where cart_id = $1 and offer_id = $2', [cartId, offerId])

/** Брошенные корзины: таблица наполняется анонимным трафиком и сама не убывает. */
export async function dropStale(days = 7) {
  const { rowCount } = await pool.query(
    `delete from cart_items where added_at < now() - ($1 || ' days')::interval`,
    [days],
  )
  return rowCount ?? 0
}
