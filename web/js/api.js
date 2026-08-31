// Один origin с бэкендом (nginx проксирует /api, /webhook, /admin), поэтому
// адрес API не настраивается — просто относительные пути.

export async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(path, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) : null
  if (!response.ok) throw new ApiError(data?.error ?? 'request_failed', data?.message, response.status)
  return data
}

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message ?? code)
    this.code = code
    this.status = status
  }
}

export const getProducts = () => request('/api/products')
export const getOrder = (id) => request(`/api/orders/${id}`)
export const quotePromo = (code, sku) => request('/api/promo/quote', { method: 'POST', body: { code, sku } })

/**
 * Создание заказа. Idempotency-Key генерируется на клик и переживает повторные
 * отправки: два клика подряд по одной кнопке дают один заказ, а не два.
 */
export const createOrder = (sku, { idempotencyKey, promoCode }) =>
  request('/api/orders', {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body: { sku, promo_code: promoCode ?? null },
  })

export const payOrder = (id, outcome, copies = 1) =>
  request(`/api/orders/${id}/pay`, { method: 'POST', body: { outcome, copies } })

export const uuid = () =>
  crypto.randomUUID ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(16).slice(2)}`

const RUB = new Intl.NumberFormat('ru-RU')
export const money = (value) => `${RUB.format(value)} ₽`
