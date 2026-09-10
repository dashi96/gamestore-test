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

export const createOrder = (sku, { key, promo, orderId, offerId, expectedPrice } = {}) =>
  api('/api/orders', {
    method: 'POST',
    headers: key ? { 'idempotency-key': key } : {},
    body: {
      sku,
      offer_id: offerId,
      promo_code: promo,
      order_id: orderId,
      expected_price_rub: expectedPrice,
    },
  })

/** Предложения товара с внутренними подробностями: продавец, поставщик, остаток. */
export const adminOffers = async (sku) => (await admin(`/admin/offers?sku=${sku}`)).body.offers

/** Предложение конкретного продавца — например, того, кто сидит на поставщике A. */
export async function pickOffer(sku, { provider } = {}) {
  const offers = await adminOffers(sku)
  const found = offers.find((o) => (provider ? o.provider_id === provider : true) && o.free > 0)
  if (!found) throw new Error(`нет свободного предложения ${sku} у поставщика ${provider}`)
  return found
}

/**
 * Довести склад товара до нужного запаса. Нужно там, где сценарий проверяет не
 * склад: иначе он падал бы не на своей причине, а на раскупленном товаре.
 * Долитые единицы убираются следующим reset().
 */
export const ensureStock = (sku, perOffer = 10) =>
  admin('/admin/stock', { method: 'POST', body: { sku, per_offer: perOffer } })

export const getOrder = (id) => api(`/api/orders/${id}`)

export const orderDebug = (id) => admin(`/admin/orders/${id}`)

export const stats = async () => (await admin('/admin/stats')).body

export const webhook = (payload) => api('/webhook/payment', { method: 'POST', body: payload })

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Приблизить срок брони. Саму бронь не снимает — это делает развёртка в воркере. */
export const expireReservation = (orderId, { hard = false } = {}) =>
  admin(`/admin/orders/${orderId}/expire`, { method: 'POST', body: { hard } })

export const setPrice = (offerId, priceRub) =>
  admin(`/admin/offers/${offerId}/price`, { method: 'POST', body: { price_rub: priceRub } })

export const addStock = (offerId, count) =>
  admin(`/admin/offers/${offerId}/stock`, { method: 'POST', body: { count } })

/** Сколько единиц предложения свободно прямо сейчас. */
export async function freeUnits(sku, offerId) {
  const offers = await adminOffers(sku)
  return offers.find((offer) => offer.id === offerId)?.free ?? 0
}

/** Создаёт заказы, пока у предложения не останется ровно `target` свободных единиц. */
export async function drainTo(sku, offerId, target) {
  for (let guard = 0; guard < 200; guard++) {
    const free = await freeUnits(sku, offerId)
    if (free <= target) return free
    const response = await createOrder(null, { key: uid('drain'), offerId })
    if (response.status !== 201) return freeUnits(sku, offerId)
  }
  throw new Error('не удалось довести остаток до нужного числа')
}

/** Ждёт выполнения условия, опрашивая его. Возвращает последнее значение. */
export async function waitUntil(read, ok, { timeoutMs = 10_000, everyMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await read()
    if (ok(last)) return last
    await sleep(everyMs)
  }
  return last
}

/**
 * Корзина живёт в httpOnly-cookie, поэтому сценарию нужен «браузер»: клиент,
 * который запоминает выданную cookie и присылает её обратно.
 */
export function cartClient() {
  let cookie = null
  return async (path, { method = 'GET', body } = {}) => {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const raw = response.headers.get('set-cookie')
    if (raw) cookie = raw.split(';')[0]
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }
}

/** Подписка на живую витрину — то же соединение, что открывает браузер. */
export async function openStream({ fromSeq = 0 } = {}) {
  const { default: WebSocket } = await import('ws')
  const url = `${API.replace(/^http/, 'ws')}/api/stream${fromSeq ? `?from_seq=${fromSeq}` : ''}`
  const socket = new WebSocket(url)
  const events = []

  socket.on('message', (data) => {
    const message = JSON.parse(data)
    if (message.type === 'events') events.push(...message.events)
  })

  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })

  return {
    events,
    /** Последнее известное состояние предложения по номеру события. */
    latest: (offerId) =>
      events.filter((event) => event.offer_id === offerId).sort((a, b) => a.seq - b.seq).at(-1) ?? null,
    close: () => socket.close(),
  }
}

/** Прямое подключение к базе — нужно там, где проверяется сама схема. */
export async function openDb() {
  const { default: pg } = await import('pg')
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL ?? 'postgres://shop:shop@localhost:5433/shop',
  })
  await client.connect()
  return client
}

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
