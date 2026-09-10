import type { FastifyInstance } from 'fastify'
import { config } from '../lib/config.ts'
import { badRequest, notFound } from '../lib/errors.ts'
import { newEventId, newIdempotencyKey } from '../lib/ids.ts'
import { createOrder } from '../core/checkout.ts'
import { catalog, currentSeq, offerStatesBySku } from '../core/events.ts'
import { getOrder, getOrderView, listProducts } from '../core/orders.ts'
import { processParked } from '../core/payments.ts'
import { markAwaitingPayment } from '../core/reservations.ts'
import { getOffer, priceForSku } from '../core/stock.ts'
import * as promo from '../core/promo.ts'
import { pool } from '../lib/db.ts'

const SORTS = new Set(['price', 'price_desc', 'name'])
const numberOrNull = (value: string | undefined) => {
  const parsed = Number(value)
  return value !== undefined && value !== '' && Number.isFinite(parsed) ? Math.trunc(parsed) : null
}

export async function shopRoutes(app: FastifyInstance) {
  app.get('/api/products', async () => ({ products: await listProducts() }))

  /**
   * Предложения одного товара: разные продавцы, разные цены, разный остаток.
   * Вместе со снимком отдаётся номер журнала, с которого клиент продолжит поток.
   *
   * Номер читается ДО самих предложений, а не после. Тогда снимок заведомо не
   * старше номера, и досылка с этого номера ничего не пропустит. В обратном
   * порядке событие, случившееся между двумя чтениями, потерялось бы: в снимок
   * не попало, а по номеру уже считается доставленным.
   */
  app.get('/api/offers', async (request) => {
    const { sku } = request.query as { sku?: string }
    if (!sku) throw badRequest('sku_required')
    const seq = await currentSeq()
    return { seq, offers: await offerStatesBySku(sku) }
  })

  /**
   * Витрина и поиск. Номер журнала читается до выборки — снимок тогда не старше
   * номера, и поток с него ничего не пропустит.
   */
  app.get('/api/catalog', async (request) => {
    const query = request.query as Record<string, string | undefined>
    const seq = await currentSeq()
    const { offers, total } = await catalog({
      q: query.q?.trim() || null,
      type: query.type || null,
      minRub: numberOrNull(query.min),
      maxRub: numberOrNull(query.max),
      sort: SORTS.has(query.sort ?? '') ? (query.sort as 'price' | 'price_desc' | 'name') : null,
      limit: Math.min(Math.max(Number(query.limit) || 24, 1), 100),
    })
    return { seq, total, offers }
  })

  /**
   * Предпросмотр скидки. Считается от цены продавца, а не от номинала каталога:
   * заказ создаётся по предложению, и показывать скидку от другой суммы значило
   * бы обещать не то, что спишется.
   */
  app.post('/api/promo/quote', async (request) => {
    const { code, sku, offer_id } = (request.body ?? {}) as {
      code?: string
      sku?: string
      offer_id?: number
    }
    if (!code) throw badRequest('code_required')

    const priceRub = offer_id
      ? (await getOffer(pool, offer_id))?.price_rub ?? null
      : sku
        ? await priceForSku(sku)
        : null
    if (priceRub === null) throw badRequest(offer_id ? 'unknown_offer' : 'unknown_sku')

    return promo.quote(code, priceRub)
  })

  /**
   * Оформление. Принимает либо `offer_id` (выбран конкретный продавец), либо
   * `sku` — путь первого этапа, там берётся самое дешёвое доступное предложение.
   * `expected_price_rub` — цена, которую покупатель видел: подорожало, значит
   * заказ не создаём и показываем новую цену ДО оплаты.
   */
  app.post('/api/orders', async (request, reply) => {
    const body = (request.body ?? {}) as {
      offer_id?: number
      sku?: string
      expected_price_rub?: number
      promo_code?: string
      order_id?: string
    }
    if (!body.offer_id && !body.sku) throw badRequest('offer_or_sku_required')

    const idempotencyKey =
      (request.headers['idempotency-key'] as string | undefined) ?? newIdempotencyKey()

    const { order, created } = await createOrder({
      offerId: body.offer_id,
      sku: body.sku,
      expectedPriceRub: body.expected_price_rub ?? null,
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
   *
   * Перед отправкой заказ уходит в awaiting_payment: пока платёж в полёте,
   * развёртка не имеет права снять бронь по обычному сроку.
   */
  app.post('/api/orders/:id/pay', async (request) => {
    const { id } = request.params as { id: string }
    const body = (request.body ?? {}) as {
      outcome?: 'success' | 'failure'
      copies?: number
      /** Платёж в полёте: вебхук уйдёт через столько миллисекунд, а не сразу. */
      delay_ms?: number
    }
    const order = await getOrder(id)
    if (!order) throw notFound('order_not_found')

    // Статус не проверяем: решение принимает обработчик вебхука. Оплата
    // заказа с уже снятой бронью — законный сценарий, он идёт в перезахват.
    await markAwaitingPayment(id)

    const copies = Math.min(Math.max(body.copies ?? 1, 1), 100)
    const payload = {
      event_id: newEventId(),
      order_id: order.id,
      status: body.outcome === 'failure' ? 'failed' : 'paid',
      amount: order.total_rub,
      currency: 'RUB',
      created_at: new Date().toISOString(),
    }

    const send = () =>
      Promise.all(
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

    const delayMs = Math.min(Math.max(body.delay_ms ?? 0, 0), 30_000)
    if (delayMs) {
      // Ответ не ждём: заказ уже в awaiting_payment, и всё время до вебхука
      // бронь обязана держаться, даже если обычный срок успел истечь.
      setTimeout(() => void send(), delayMs)
      return { sent: copies, event_id: payload.event_id, scheduled_in_ms: delayMs }
    }

    return { sent: copies, event_id: payload.event_id, results: await send() }
  })
}
