import {
  adminOffers, api, checker, createOrder, ensureStock, freeUnits, getOrder,
  orderDebug, reset, setProvider, uid, waitForStatus, waitUntil,
} from './lib.mjs'

export const name = 'Отказ оплаты вернул товар, а потом пришло «оплачено»: заказ всё равно выдан'

const SKU = 'STEAM-TOPUP-1000'

const pay = (id, outcome) =>
  api(`/api/orders/${id}/pay`, { method: 'POST', body: { outcome, copies: 1 } })

export async function run() {
  const c = checker()
  await reset()
  await setProvider('a', { errorRate: 0, timeoutRate: 0 })
  await setProvider('b', { errorRate: 0, timeoutRate: 0 })
  await ensureStock(SKU, 5)
  const [offer] = await adminOffers(SKU)

  const before = await freeUnits(SKU, offer.id)
  const order = (await createOrder(null, { key: uid('ff'), offerId: offer.id })).body
  c.eq('бронь заняла единицу', await freeUnits(SKU, offer.id), before - 1)

  await pay(order.id, 'failure')
  const failed = await waitUntil(
    async () => (await getOrder(order.id)).body,
    (o) => o.status === 'payment_failed',
  )
  c.eq('заказ в отказе оплаты', failed.status, 'payment_failed')
  c.ok('брони больше нет', failed.reservation === null, JSON.stringify(failed.reservation))
  c.eq('товар сразу вернулся в продажу', await freeUnits(SKU, offer.id), before)

  // Вебхуки приходят не по порядку: «оплачено» может прийти после «отказ».
  // Деньги пришли — товар надо выдать, даже если бронь уже сняли.
  await pay(order.id, 'success')
  const delivered = await waitForStatus(order.id, ['delivered', 'out_of_stock'], 30_000)
  c.eq('поздняя оплата поднимает заказ и доводит до выдачи', delivered.status, 'delivered')
  c.ok('код выдан', Boolean(delivered.delivery?.code), delivered.delivery?.code)

  const notes = (await orderDebug(order.id)).body.events.map((e) => e.note)
  c.ok('сначала отказ, потом перезахват под оплату',
    notes.includes('payment_failed') && notes.includes('paid_reclaimed'), notes.join(', '))
  c.eq('единица снова занята — уже продажей', await freeUnits(SKU, offer.id), before - 1)

  // Повторный отказ после выдачи ничего не отменяет: paid сильнее failed.
  await pay(order.id, 'failure')
  const after = await waitUntil(async () => (await getOrder(order.id)).body, () => true, { timeoutMs: 1500 })
  c.eq('поздний отказ не отменяет выдачу', after.status, 'delivered')
  c.eq('и код остаётся тем же', after.delivery?.code, delivered.delivery.code)
  return c.checks
}
