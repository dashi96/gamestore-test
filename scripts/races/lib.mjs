// Общая обвязка для сценариев гонок. Всё через HTTP: скрипты одинаково
// работают и с хоста (npm run races), и из контейнера (docker compose run races).

export const API = process.env.API_URL ?? 'http://localhost:3000'
export const TOKEN = process.env.ADMIN_TOKEN ?? 'admin-token'

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  // content-type ставим только при наличии тела: fastify отвечает 400 на
  // пустое тело с application/json, и такой сбой легко не заметить.
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  const parsed = text ? JSON.parse(text) : null
  return { status: response.status, body: parsed }
}

export const admin = (path, options = {}) =>
  api(path, { ...options, headers: { authorization: `Bearer ${TOKEN}`, ...(options.headers ?? {}) } })

export async function reset() {
  const result = await admin('/admin/reset', { method: 'POST' })
  if (result.status !== 200) throw new Error(`сброс состояния не удался: ${JSON.stringify(result)}`)
  return result
}

export const providers = async () => (await admin('/admin/providers')).body

/** Сколько ключей реально ушло из остатков обоих поставщиков. */
export async function keysConsumed() {
  const state = await providers()
  return state.a.stats.issued + state.b.stats.issued
}

export const setProvider = (id, config) =>
  admin(`/admin/providers/${id}/config`, { method: 'POST', body: config })

export const setStock = (id, body) => admin(`/admin/providers/${id}/stock`, { method: 'POST', body })

export const createOrder = (sku, { key, promo, orderId } = {}) =>
  api('/api/orders', {
    method: 'POST',
    headers: key ? { 'idempotency-key': key } : {},
    body: { sku, promo_code: promo, order_id: orderId },
  })

export const getOrder = (id) => api(`/api/orders/${id}`)

export const orderDebug = (id) => admin(`/admin/orders/${id}`)

export const stats = async () => (await admin('/admin/stats')).body

export const webhook = (payload) => api('/webhook/payment', { method: 'POST', body: payload })

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const uid = (prefix) => `${prefix}_${Math.random().toString(16).slice(2, 10)}`

/** Ждём, пока заказ придёт в одно из ожидаемых состояний. */
export async function waitForStatus(id, statuses, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const { body } = await getOrder(id)
    last = body
    if (statuses.includes(body.status)) return body
    await sleep(150)
  }
  throw new Error(`заказ ${id} не дошёл до [${statuses}], застрял в ${last?.status}`)
}

/** Мини-ассерты: сценарий возвращает список проверок, раннер печатает таблицу. */
export function checker() {
  const checks = []
  return {
    checks,
    eq(label, actual, expected) {
      checks.push({ label, ok: actual === expected, actual, expected })
    },
    ok(label, condition, detail = '') {
      checks.push({ label, ok: Boolean(condition), actual: detail, expected: 'true' })
    },
  }
}
