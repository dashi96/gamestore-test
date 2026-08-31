import type { Client } from '../lib/db.ts'
import { pool, tx } from '../lib/db.ts'
import { badRequest, notFound } from '../lib/errors.ts'
import { newOrderId } from '../lib/ids.ts'
import * as promo from './promo.ts'

export type OrderStatus =
  | 'created'
  | 'paid'
  | 'delivering'
  | 'delivered'
  | 'payment_failed'
  | 'out_of_stock'
  | 'delivery_failed'

export type Order = {
  id: string
  sku: string
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

export type Product = { sku: string; name: string; type: string; price_rub: number; image: string | null }

export const listProducts = async () =>
  (await pool.query<Product>('select * from products order by price_rub')).rows

export async function getOrder(id: string) {
  const { rows } = await pool.query<Order>('select * from orders where id = $1', [id])
  return rows[0] ?? null
}

export async function getOrderView(id: string) {
  const order = await getOrder(id)
  if (!order) throw notFound('order_not_found')
  const [{ rows: delivery }, { rows: product }] = await Promise.all([
    pool.query<{ code: string; provider: string; delivered_at: Date }>(
      'select code, provider, delivered_at from deliveries where order_id = $1',
      [id],
    ),
    pool.query<Product>('select * from products where sku = $1', [order.sku]),
  ])
  return { ...order, product: product[0] ?? null, delivery: delivery[0] ?? null }
}

type CreateInput = {
  sku: string
  promoCode?: string | null
  idempotencyKey: string
  /** Позволяет задать id заранее — нужно, чтобы воспроизвести «вебхук раньше заказа». */
  orderId?: string
}

/**
 * Создание заказа. Идемпотентность по Idempotency-Key: двойной клик «Купить»
 * шлёт два запроса с одним ключом, второй не создаёт заказ, а возвращает первый.
 * Порядок внутри транзакции важен: сначала вставка заказа (там и ловится
 * конфликт ключа), только потом расход промокода — иначе дубликат запроса
 * съедал бы лимит промокода впустую.
 */
export async function createOrder(input: CreateInput): Promise<{ order: Order; created: boolean }> {
  const { rows: products } = await pool.query<Product>('select * from products where sku = $1', [input.sku])
  const product = products[0]
  if (!product) throw badRequest('unknown_sku', 'Такого товара нет')

  const existingByKey = await findByIdempotencyKey(input.idempotencyKey)
  if (existingByKey) return { order: existingByKey, created: false }

  try {
    const order = await tx(async (client) => {
      const id = input.orderId ?? newOrderId()
      const { rows } = await client.query<Order>(
        `insert into orders (id, sku, status, amount_rub, discount_rub, total_rub, promo_code, idempotency_key)
         values ($1, $2, 'created', $3, 0, $3, null, $4)
         on conflict (idempotency_key) do nothing
         returning *`,
        [id, product.sku, product.price_rub, input.idempotencyKey],
      )
      const created = rows[0]
      if (!created) throw new DuplicateRequest()

      if (!input.promoCode) return created

      const applied = await promo.reserve(client, input.promoCode, created.id, product.price_rub)
      const { rows: updated } = await client.query<Order>(
        `update orders set promo_code = $2, discount_rub = $3, total_rub = amount_rub - $3, updated_at = now()
          where id = $1 returning *`,
        [created.id, applied.code, applied.discount],
      )
      return updated[0]!
    })
    return { order, created: true }
  } catch (err) {
    if (!(err instanceof DuplicateRequest)) throw err
    const existing = await findByIdempotencyKey(input.idempotencyKey)
    if (!existing) throw err
    return { order: existing, created: false }
  }
}

class DuplicateRequest extends Error {}

async function findByIdempotencyKey(key: string) {
  const { rows } = await pool.query<Order>('select * from orders where idempotency_key = $1', [key])
  return rows[0] ?? null
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
