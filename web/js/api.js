// Один origin с бэкендом (nginx проксирует /api, /webhook, /admin), поэтому
// адрес API не настраивается — просто относительные пути.

export async function request(path, { method = 'GET', body, headers = {}, signal } = {}) {
  const response = await fetch(path, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) : null
  if (!response.ok) throw new ApiError(data, response.status)
  return data
}

/**
 * Ошибка API вместе с подробностями. Сервер кладёт в тело отказа то, без чего
 * его не показать по-человечески: предложения других продавцов при `sold_out`
 * и обе цены при `price_changed`. Раньше сюда переносились только код и текст,
 * и «раскупили» оставалось без альтернативы, а «цена изменилась» — с NaN.
 */
export class ApiError extends Error {
  constructor(body, status) {
    super(body?.message ?? body?.error ?? 'request_failed')
    Object.assign(this, body ?? {})
    this.code = body?.error ?? 'request_failed'
    this.status = status
  }
}

export const getProducts = () => request('/api/products')
export const getOrder = (id) => request(`/api/orders/${id}`)
export const quotePromo = (code, sku) => request('/api/promo/quote', { method: 'POST', body: { code, sku } })

/** Предложения товара: снимок плюс номер, с которого продолжится поток. */
export const getOffers = (sku) => request(`/api/offers?sku=${encodeURIComponent(sku)}`)

export const getCart = () => request('/api/cart')
export const addToCart = (offerId) => request('/api/cart', { method: 'POST', body: { offer_id: offerId } })
export const removeFromCart = (offerId) => request(`/api/cart/${offerId}`, { method: 'DELETE' })

/**
 * Создание заказа. Idempotency-Key генерируется на клик и переживает повторные
 * отправки: два клика подряд по одной кнопке дают один заказ, а не два.
 */
export const createOrder = (
  { sku = null, offerId = null, expectedPrice = null },
  { idempotencyKey, promoCode },
) =>
  request('/api/orders', {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body: {
      sku,
      offer_id: offerId,
      // Цена, которую покупатель видел на экране: подорожало — сервер откажет и
      // покажет новую цену ДО оплаты, а не после.
      expected_price_rub: expectedPrice,
      promo_code: promoCode ?? null,
    },
  })

/** delayMs > 0 — платёж «в пути»: вебхук уйдёт с задержкой, бронь обязана дожить. */
export const payOrder = (id, outcome, copies = 1, delayMs = 0) =>
  request(`/api/orders/${id}/pay`, { method: 'POST', body: { outcome, copies, delay_ms: delayMs } })

export const uuid = () =>
  crypto.randomUUID ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(16).slice(2)}`

const RUB = new Intl.NumberFormat('ru-RU')
export const money = (value) => `${RUB.format(value)} ₽`
