import type { FastifyInstance } from 'fastify'
import { config } from '../lib/config.ts'
import { badRequest, notFound } from '../lib/errors.ts'
import { newEventId, newIdempotencyKey } from '../lib/ids.ts'
import { createOrder, getOrder, getOrderView, listProducts } from '../core/orders.ts'
import { processParked } from '../core/payments.ts'
import * as promo from '../core/promo.ts'
import { pool } from '../lib/db.ts'

export async function shopRoutes(app: FastifyInstance) {
  app.get('/api/products', async () => ({ products: await listProducts() }))

  app.post('/api/promo/quote', async (request) => {
    const { code, sku } = (request.body ?? {}) as { code?: string; sku?: string }
    if (!code || !sku) throw badRequest('code_and_sku_required')
    const { rows } = await pool.query<{ price_rub: number }>(
      'select price_rub from products where sku = $1',
      [sku],
    )
    const product = rows[0]
    if (!product) throw badRequest('unknown_sku')
    return promo.quote(code, product.price_rub)
  })

  app.post('/api/orders', async (request, reply) => {
    const body = (request.body ?? {}) as { sku?: string; promo_code?: string; order_id?: string }
    if (!body.sku) throw badRequest('sku_required')

    const idempotencyKey =
      (request.headers['idempotency-key'] as string | undefined) ?? newIdempotencyKey()

    const { order, created } = await createOrder({
      sku: body.sku,
      promoCode: body.promo_code ?? null,
      idempotencyKey,
      orderId: body.order_id,
    })

    // Вебхук мог прийти раньше, чем заказ появился, — подбираем такие события сразу.
    await processParked(order.id)

    reply.code(created ? 201 : 200)
    return { ...(await getOrderView(order.id)), deduplicated: !created }
  })

  app.get('/api/orders/:id', async (request) => {
    const { id } = request.params as { id: string }
    return getOrderView(id)
  })

  /**
   * Платёжка-заглушка. Реального эквайринга нет: эндпоинт просто отправляет
   * вебхук по контракту на наш же /webhook/payment. copies > 1 отправляет одно
   * и то же событие несколько раз (проверка идемпотентности прямо из UI).
   */
  app.post('/api/orders/:id/pay', async (request) => {
    const { id } = request.params as { id: string }
    const body = (request.body ?? {}) as { outcome?: 'success' | 'failure'; copies?: number }
    const order = await getOrder(id)
    if (!order) throw notFound('order_not_found')

    const copies = Math.min(Math.max(body.copies ?? 1, 1), 100)
    const payload = {
      event_id: newEventId(),
      order_id: order.id,
      status: body.outcome === 'failure' ? 'failed' : 'paid',
      amount: order.total_rub,
      currency: 'RUB',
      created_at: new Date().toISOString(),
    }

    const results = await Promise.all(
      Array.from({ length: copies }, () =>
        fetch(`${config.selfUrl}/webhook/payment`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
          .then((r) => r.json() as Promise<{ result?: string }>)
          .then((r) => r.result ?? 'unknown')
          .catch((e) => `error:${e.name}`),
      ),
    )

    return { sent: copies, event_id: payload.event_id, results }
  })
}
