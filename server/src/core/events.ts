import type { Client } from '../lib/db.ts'
import { pool } from '../lib/db.ts'
import { FREE_UNIT } from './stock.ts'

/**
 * Журнал витрины. Событие несёт ПОЛНОЕ состояние предложения, а не приращение,
 * и в этом весь смысл: `bigserial` выдаёт номер при вставке, а не при фиксации,
 * поэтому событие с меньшим номером может зафиксироваться позже. Полное
 * состояние делает повторное и запоздавшее применение безвредным — клиент
 * держит максимум номера на каждое предложение и просто игнорирует старое.
 *
 * Второе правило, обязательное для всех вызывающих: `emit` вызывается ПОСЛЕ
 * изменения строк, в той же транзакции. Тогда для одного предложения порядок
 * номеров совпадает с порядком фиксации — их сериализует блокировка строки,
 * которая и так взята. Разнобой между разными предложениями безопасен.
 */

export const CHANNEL = 'offers'

export type OfferState = {
  offer_id: number
  sku: string
  name: string
  type: string
  image: string | null
  seller_id: string
  seller_name: string
  price_rub: number
  available: number
  /** Сколько всего продавцов у товара. Карточка витрины показывает «и ещё N». */
  sellers: number
  seq: number
}

const STATE_SQL = `
  select o.id as offer_id, o.sku, p.name, p.type, p.image,
         o.seller_id, s.name as seller_name, o.price_rub,
         (select count(*)::int from stock_units u
           where u.offer_id = o.id and ${FREE_UNIT}) as available,
         (select count(*)::int from offers o2 where o2.sku = o.sku) as sellers
    from offers o
    join products p using (sku)
    join sellers s on s.id = o.seller_id`

export async function offerState(client: Client, offerId: number) {
  const { rows } = await client.query<Omit<OfferState, 'seq'>>(
    `${STATE_SQL} where o.id = $1`,
    [offerId],
  )
  return rows[0] ?? null
}

/**
 * Записать состояние предложения в журнал и разбудить подписчиков.
 * В канал уходит только номер: у `NOTIFY` восемь килобайт на сообщение,
 * а состояние читается из `events`.
 */
export async function emit(client: Client, offerId: number): Promise<number | null> {
  const state = await offerState(client, offerId)
  if (!state) return null
  const { rows } = await client.query<{ seq: number }>(
    'insert into events (offer_id, state) values ($1, $2) returning seq',
    [offerId, state],
  )
  const seq = rows[0]!.seq
  await client.query('select pg_notify($1, $2)', [CHANNEL, String(seq)])
  return seq
}

/** Текущий номер журнала: снимок витрины снят на нём, с него же идёт поток. */
export async function currentSeq(): Promise<number> {
  const { rows } = await pool.query<{ seq: number | null }>('select max(seq) as seq from events')
  return rows[0]?.seq ?? 0
}

/**
 * Состояние предложения для доставки подписчикам.
 *
 * Читается заново, а НЕ берётся из сохранённого в событии. Пишущая транзакция
 * считает остаток по своему снимку и чужой, ещё не зафиксированный захват видит
 * свободным: две параллельные покупки у одного продавца обе сообщили бы
 * «осталось 4», когда осталось 3, и на последних единицах кнопка не погасла бы.
 *
 * Сериализовать транзакции блокировкой предложения нельзя: заказ ссылается на
 * предложение внешним ключом и уже держит на нём share-блокировку, так что
 * `for update` стал бы её повышением — и две покупки встают в дедлок.
 *
 * `NOTIFY` срабатывает при фиксации, поэтому к моменту доставки записанное уже
 * зафиксировано, и чтение здесь видит остаток целиком. В самом событии
 * сохранённое состояние остаётся историей: что видел писавший.
 *
 * Полной сериализации это не даёт: если две покупки зафиксируются в порядке,
 * обратном номерам событий, доставка с бо́льшим номером может прочитать состояние
 * до фиксации соседней, и клиент отбросит более свежее чтение с меньшим номером.
 * Показ отстанет на единицу до следующего события по этому предложению. Двенадцать
 * прогонов по шесть одновременных покупок расхождения не дали, а купить сверх
 * остатка нельзя в любом случае: единицу выдаёт сервер, а не показанное число.
 */
const DELIVERY_SQL = `
  select e.seq, o.id as offer_id, o.sku, p.name, p.type, p.image,
         o.seller_id, s.name as seller_name, o.price_rub,
         (select count(*)::int from stock_units u
           where u.offer_id = o.id and ${FREE_UNIT}) as available,
         (select count(*)::int from offers o2 where o2.sku = o.sku) as sellers
    from events e
    join offers o on o.id = e.offer_id
    join products p on p.sku = o.sku
    join sellers s on s.id = o.seller_id`

/** Одно событие по номеру: его приносит `NOTIFY`, в котором только номер и есть. */
export async function bySeq(seq: number): Promise<OfferState | null> {
  const { rows } = await pool.query<OfferState>(`${DELIVERY_SQL} where e.seq = $1`, [seq])
  return rows[0] ?? null
}

/**
 * События после указанного номера — досылка при подключении и после обрыва
 * слушателя. Вызывается с перекрытием назад: `bigserial` выдаёт номер при
 * вставке, а не при фиксации, поэтому событие с меньшим номером могло
 * зафиксироваться позже уже полученного. Повторная выдача безвредна — состояние
 * полное, и клиент отбросит его по номеру.
 */
export async function since(seq: number, limit = 500): Promise<OfferState[]> {
  const { rows } = await pool.query<OfferState>(
    `${DELIVERY_SQL} where e.seq > $1 order by e.seq limit $2`,
    [seq, limit],
  )
  return rows
}

/** Состояние набора предложений — то, что лежит в корзине. */
export async function offerStatesByIds(offerIds: number[]) {
  if (!offerIds.length) return []
  const { rows } = await pool.query<Omit<OfferState, 'seq'>>(
    `${STATE_SQL} where o.id = any($1::bigint[])`,
    [offerIds],
  )
  return rows
}

/**
 * Каталог и поиск: по одному предложению на товар — лучшее из доступных.
 *
 * «Лучшее» это сначала наличие, потом цена: показывать самую низкую цену у
 * распроданного продавца, когда у соседнего товар есть, — обманывать покупателя.
 * Число продавцов идёт рядом, чтобы с карточки было видно, что выбор есть.
 *
 * `count(*) over ()` считает найденное тем же запросом: отдельный SELECT count
 * пришлось бы держать с теми же условиями, и они бы разъезжались.
 */

export type CatalogFilters = {
  q?: string | null
  type?: string | null
  minRub?: number | null
  maxRub?: number | null
  sort?: 'price' | 'price_desc' | 'name' | null
  limit?: number
}

export type CatalogRow = Omit<OfferState, 'seq'> & { total: number }

const ORDER = {
  price: 'b.price_rub, b.offer_id',
  price_desc: 'b.price_rub desc, b.offer_id',
  name: 'p.name, b.offer_id',
  // Без запроса и сортировки — устойчивая вперемешку выборка: по названию
  // витрина показывала бы подряд все варианты одной игры.
  shuffle: 'md5(b.sku)',
} as const

export async function catalog(filters: CatalogFilters) {
  const { q = null, type = null, minRub = null, maxRub = null, sort = null, limit = 24 } = filters
  // С запросом по умолчанию сортируем по названию: вперемешку выдача поиска
  // выглядит случайной, а она такой не является.
  const order = ORDER[sort ?? (q ? 'name' : 'shuffle')]

  const { rows } = await pool.query<CatalogRow>(
    `with ranked as (
       select o.sku, o.id as offer_id, o.seller_id, o.price_rub,
              exists (select 1 from stock_units u where u.offer_id = o.id and ${FREE_UNIT}) as in_stock
         from offers o
     ),
     best as (
       select distinct on (sku) * from ranked
        order by sku, in_stock desc, price_rub, offer_id
     )
     select b.offer_id, b.sku, p.name, p.type, p.image,
            b.seller_id, s.name as seller_name, b.price_rub,
            (select count(*)::int from stock_units u where u.offer_id = b.offer_id and ${FREE_UNIT}) as available,
            (select count(*)::int from offers o2 where o2.sku = b.sku) as sellers,
            count(*) over ()::int as total
       from best b
       join products p on p.sku = b.sku
       join sellers s on s.id = b.seller_id
      where ($1::text is null or p.type = $1)
        and ($2::text is null or p.name ilike '%' || $2 || '%')
        and ($3::int  is null or b.price_rub >= $3)
        and ($4::int  is null or b.price_rub <= $4)
      order by ${order}
      limit $5`,
    [type, q, minRub, maxRub, limit],
  )
  return { offers: rows, total: rows[0]?.total ?? 0 }
}

/** Предложения одного товара — карточка товара и выбор продавца. */
export async function offerStatesBySku(sku: string) {
  const { rows } = await pool.query<Omit<OfferState, 'seq'>>(
    `${STATE_SQL} where o.sku = $1 order by o.price_rub, o.id`,
    [sku],
  )
  return rows
}
