import { adminOffers, checker, createOrder, ensureStock, openDb, reset, uid } from './lib.mjs'

export const name = 'Один товар не уходит в две брони: это держит схема, а не код'

const SKU = 'GIFT-PSN-1000'

export async function run() {
  const c = checker()
  await reset()
  await ensureStock(SKU, 3)
  const [offer] = await adminOffers(SKU)

  const first = await createOrder(null, { key: uid('one'), offerId: offer.id })
  const second = await createOrder(null, { key: uid('two'), offerId: offer.id })
  c.eq('первый заказ создан', first.status, 201)
  c.eq('второй заказ создан', second.status, 201)

  const db = await openDb()
  try {
    const { rows } = await db.query(
      `select r.unit_id, r.order_id from reservations r
        where r.order_id = any($1) and r.released_at is null`,
      [[first.body.id, second.body.id]],
    )
    c.eq('у каждого заказа своя бронь', rows.length, 2)
    c.eq('и разные единицы склада', new Set(rows.map((r) => r.unit_id)).size, 2)

    // Обходим приложение и пробуем сделать то, что оно не даёт: вторую активную
    // бронь на ту же единицу. Если рассуждение о блокировках когда-нибудь
    // окажется неверным, упасть должна вставка, а не выдача товара.
    const unitId = rows[0].unit_id
    let violation = null
    try {
      await db.query(
        `insert into reservations (unit_id, order_id, price_rub, expires_at, hard_expires_at)
         values ($1, $2, 100, now() + interval '7 minutes', now() + interval '20 minutes')`,
        [unitId, second.body.id],
      )
    } catch (err) {
      violation = { code: err.code, constraint: err.constraint }
    }
    c.eq('вторая бронь на ту же единицу невозможна', violation?.code, '23505')
    c.eq('и останавливает её именно индекс по единице', violation?.constraint, 'reservations_unit_active')

    // Второе требование той же таблицы: один заказ не держит две единицы.
    const free = await db.query(
      `select id from stock_units where offer_id = $1 and held_by_order is null and sold_order_id is null limit 1`,
      [offer.id],
    )
    let secondUnit = null
    try {
      await db.query(
        `insert into reservations (unit_id, order_id, price_rub, expires_at, hard_expires_at)
         values ($1, $2, 100, now() + interval '7 minutes', now() + interval '20 minutes')`,
        [free.rows[0].id, first.body.id],
      )
    } catch (err) {
      secondUnit = { code: err.code, constraint: err.constraint }
    }
    c.eq('один заказ не может держать две единицы', secondUnit?.constraint, 'reservations_order_active')

    // И то же самое про продажу: две единицы на один заказ схема не пустит.
    let doubleSold = null
    try {
      await db.query('update stock_units set sold_order_id = $2 where id = $1', [free.rows[0].id, first.body.id])
      await db.query(
        `update stock_units set sold_order_id = $2
          where id = (select id from stock_units where offer_id = $1
                       and held_by_order is null and sold_order_id is null limit 1)`,
        [offer.id, first.body.id],
      )
    } catch (err) {
      doubleSold = { constraint: err.constraint }
    }
    c.eq('и двух проданных единиц на один заказ тоже', doubleSold?.constraint, 'stock_units_sold_uniq')
  } finally {
    await db.end()
  }
  return c.checks
}
