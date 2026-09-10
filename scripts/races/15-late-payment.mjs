import {
  adminOffers, checker, createOrder, ensureStock, expireReservation, freeUnits,
  getOrder, orderDebug, reset, setProvider, uid, waitUntil, waitForStatus, api,
} from './lib.mjs'

export const name = 'Оплата пришла после снятия брони: перезахват, а не оплаченный заказ без товара'

const SKU = 'SUB-YT-3M'

const pay = (id, { delayMs = 0, outcome = 'success' } = {}) =>
  api(`/api/orders/${id}/pay`, { method: 'POST', body: { outcome, copies: 1, delay_ms: delayMs } })

export async function run() {
  const c = checker()
  await reset()
  await setProvider('a', { errorRate: 0, timeoutRate: 0 })
  await setProvider('b', { errorRate: 0, timeoutRate: 0 })
  await ensureStock(SKU, 6)
  const [offer] = await adminOffers(SKU)

  // ── Часть 1. Бронь сняли, деньги пришли позже. Товар у продавца ещё есть.
  const first = (await createOrder(null, { key: uid('late'), offerId: offer.id })).body
  await expireReservation(first.id)
  const expired = await waitUntil(
    async () => (await getOrder(first.id)).body,
    (o) => o.status === 'reservation_expired',
  )
  c.eq('бронь снята до оплаты', expired.status, 'reservation_expired')

  await pay(first.id)
  const revived = await waitForStatus(first.id, ['delivered', 'out_of_stock'], 30_000)
  c.eq('заказ всё равно доведён до выдачи', revived.status, 'delivered')
  c.ok('код выдан', Boolean(revived.delivery?.code), revived.delivery?.code)

  const notes = (await orderDebug(first.id)).body.events.map((e) => e.note)
  c.ok('в журнале видно, что единицу пришлось перезахватить',
    notes.includes('paid_reclaimed'), notes.join(', '))

  // ── Часть 2. Платёж в полёте, обычный срок брони истёк.
  // Это основной путь защиты: пока заказ ждёт оплату, развёртка его не трогает.
  const second = (await createOrder(null, { key: uid('inflight'), offerId: offer.id })).body
  await pay(second.id, { delayMs: 2500 })

  const awaiting = await waitUntil(
    async () => (await getOrder(second.id)).body,
    (o) => o.status === 'awaiting_payment',
    { timeoutMs: 3000 },
  )
  c.eq('заказ ушёл в ожидание платежа', awaiting.status, 'awaiting_payment')

  await expireReservation(second.id) // двигаем ТОЛЬКО обычный срок
  await new Promise((resolve) => setTimeout(resolve, 1200))
  const stillHeld = (await getOrder(second.id)).body
  c.ok('бронь пережила истёкший срок, пока платёж в пути',
    stillHeld.reservation !== null, JSON.stringify(stillHeld.status))
  c.ok('и заказ не помечен истёкшим',
    stillHeld.status !== 'reservation_expired', stillHeld.status)

  const paid = await waitForStatus(second.id, ['delivered', 'out_of_stock'], 30_000)
  c.eq('после прихода вебхука заказ выдан', paid.status, 'delivered')
  const inflightNotes = (await orderDebug(second.id)).body.events.map((e) => e.note)
  c.ok('и перезахватывать ничего не понадобилось',
    inflightNotes.includes('paid') && !inflightNotes.includes('paid_reclaimed'), inflightNotes.join(', '))

  // ── Часть 3. Платёж завис навсегда: потолок отпускает товар.
  const third = (await createOrder(null, { key: uid('hung'), offerId: offer.id })).body
  const before = await freeUnits(SKU, offer.id)
  await pay(third.id, { delayMs: 30_000 })
  await expireReservation(third.id, { hard: true })
  const released = await waitUntil(
    async () => (await getOrder(third.id)).body,
    (o) => o.status === 'reservation_expired',
    { timeoutMs: 8000 },
  )
  c.eq('зависший платёж не запирает товар навсегда', released.status, 'reservation_expired')
  c.eq('единица вернулась в продажу', await freeUnits(SKU, offer.id), before + 1)
  return c.checks
}
