import type { Client } from '../lib/db.ts'
import { pool } from '../lib/db.ts'
import { notFound } from '../lib/errors.ts'

export type OrderStatus =
  | 'created'
  /** Нажали «оплатить»: бронь держится до потолка, а не до обычного срока. */
  | 'awaiting_payment'
  | 'paid'
  | 'delivering'
  | 'delivered'
  | 'payment_failed'
  | 'out_of_stock'
  | 'delivery_failed'
  /** Бронь истекла раньше, чем платёж начался. */
  | 'reservation_expired'

export type Order = {
  id: string
  sku: string
  offer_id: number | null
  status: OrderStatus
  amount_rub: number
  discount_rub: number
  total_rub: number
  promo_code: string | null
  idempotency_key: string | null
  status_reason: string | null
  created_at: Date
  updated_at: Date
}

export type Product = {
  sku: string
  name: string
  type: string
  price_rub: number
  image: string | null
}

export const listProducts = async () =>
  (await pool.query<Product>('select * from products order by price_rub')).rows

export async function getOrder(id: string) {
  const { rows } = await pool.query<Order>('select * from orders where id = $1', [id])
  return rows[0] ?? null
}

/**
 * Заказ для страницы оформления. Отдаёт бронь вместе со своим текущим временем:
 * клиент считает поправку один раз и рисует отсчёт от абсолютного момента,
 * поэтому уснувшая в фоне вкладка после пробуждения показывает правду сразу.
 * Решение об истечении принимает только сервер — отсчёт остаётся показом.
 */
export async function getOrderView(id: string) {
  const order = await getOrder(id)
  if (!order) throw notFound('order_not_found')

  const [{ rows: delivery }, { rows: product }, { rows: reservation }, { rows: offer }] =
    await Promise.all([
      pool.query<{ code: string; provider: string; delivered_at: Date }>(
        'select code, provider, delivered_at from deliveries where order_id = $1',
        [id],
      ),
      pool.query<Product>('select * from products where sku = $1', [order.sku]),
      pool.query<{ expires_at: Date; hard_expires_at: Date; price_rub: number }>(
        `select expires_at, hard_expires_at, price_rub from reservations
          where order_id = $1 and released_at is null`,
        [id],
      ),
      pool.query<{ seller_id: string; seller_name: string; price_rub: number }>(
        `select o.seller_id, s.name as seller_name, o.price_rub
           from offers o join sellers s on s.id = o.seller_id where o.id = $1`,
        [order.offer_id],
      ),
    ])

  return {
    ...order,
    product: product[0] ?? null,
    offer: offer[0] ?? null,
    delivery: delivery[0] ?? null,
    reservation: reservation[0] ?? null,
    server_now: new Date().toISOString(),
  }
}

export async function findByIdempotencyKey(key: string) {
  const { rows } = await pool.query<Order>('select * from orders where idempotency_key = $1', [key])
  return rows[0] ?? null
}

/**
 * Вставка заказа. `on conflict (idempotency_key) do nothing` — здесь и ловится
 * двойной клик «Купить»: второй запрос с тем же ключом не создаёт строку.
 *
 * Предложение и сумма проставляются следом, в той же транзакции: продавец
 * становится известен только после захвата единицы склада, а цену диктует он.
 * @returns null, если ключ уже занят.
 */
export async function insertOrder(
  client: Client,
  input: { id: string; sku: string; idempotencyKey: string },
) {
  const { rows } = await client.query<Order>(
    `insert into orders (id, sku, status, amount_rub, discount_rub, total_rub, idempotency_key)
     values ($1, $2, 'created', 0, 0, 0, $3)
     on conflict (idempotency_key) do nothing
     returning *`,
    [input.id, input.sku, input.idempotencyKey],
  )
  return rows[0] ?? null
}

/** Закрепить за заказом предложение и цену, по которой единица захвачена. */
export async function setOffer(client: Client, id: string, offerId: number, priceRub: number) {
  const { rows } = await client.query<Order>(
    `update orders set offer_id = $2, amount_rub = $3, total_rub = $3, updated_at = now()
      where id = $1 returning *`,
    [id, offerId, priceRub],
  )
  return rows[0]!
}

/** Заказ под блокировкой строки — все переходы статуса идут только так. */
export async function lockOrder(client: Client, id: string) {
  const { rows } = await client.query<Order>('select * from orders where id = $1 for update', [id])
  return rows[0] ?? null
}

export async function setStatus(
  client: Client,
  id: string,
  status: OrderStatus,
  reason: string | null = null,
) {
  await client.query(
    'update orders set status = $2, status_reason = $3, updated_at = now() where id = $1',
    [id, status, reason],
  )
}
