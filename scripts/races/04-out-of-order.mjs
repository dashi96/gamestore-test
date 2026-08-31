import { checker, createOrder, keysConsumed, orderDebug, reset, setProvider, uid, waitForStatus, webhook } from './lib.mjs'

export const name = 'Не по порядку: вебхук «оплачено» приходит раньше, чем создан заказ'

export async function run() {
  const c = checker()
  await reset()
  await setProvider('a', { errorRate: 0, timeoutRate: 0 })

  const orderId = uid('ord')
  const before = await keysConsumed()

  // Заказа ещё нет. Платёжка уже прислала оплату.
  const early = await webhook({
    event_id: uid('evt'),
    order_id: orderId,
    status: 'paid',
    amount: 1990,
    currency: 'RUB',
  })

  c.eq('вебхук-сирота принят с 200', early.status, 200)
  c.eq('и припаркован, а не потерян', early.body.result, 'parked')

  const created = await createOrder('KEY-GTA5', { key: uid('late'), orderId })
  c.eq('заказ создан с тем же id', created.body.id, orderId)

  const delivered = await waitForStatus(orderId, ['delivered'])
  const debug = await orderDebug(orderId)

  c.eq('припаркованное событие применено', delivered.status, 'delivered')
  c.ok('событие помечено обработанным', debug.body.events[0]?.processed_at !== null)
  c.eq('израсходован ровно 1 ключ', (await keysConsumed()) - before, 1)
  return c.checks
}
