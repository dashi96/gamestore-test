import { checker, createOrder, keysConsumed, orderDebug, reset, setProvider, uid, waitForStatus, webhook } from './lib.mjs'

export const name = 'Повторная доставка: тот же event_id приходит ещё раз спустя время'

export async function run() {
  const c = checker()
  await reset()
  await setProvider('a', { errorRate: 0, timeoutRate: 0 })

  const order = (await createOrder('KEY-CS2-PRIME', { key: uid('repeat') })).body
  const event = {
    event_id: uid('evt'),
    order_id: order.id,
    status: 'paid',
    amount: order.total_rub,
    currency: 'RUB',
  }

  const before = await keysConsumed()
  const first = await webhook(event)
  const delivered = await waitForStatus(order.id, ['delivered'])

  // Повтор уже после того, как заказ полностью обработан.
  const second = await webhook(event)
  const third = await webhook(event)
  const after = await orderDebug(order.id)

  c.eq('первый вебхук принят', first.body.result, 'accepted')
  c.eq('повтор распознан как дубль', second.body.result, 'duplicate')
  c.eq('и второй повтор тоже', third.body.result, 'duplicate')
  c.eq('повторы отвечают 200, а не 5xx', second.status, 200)
  c.eq('событие в журнале одно', after.body.events.length, 1)
  c.eq('ключ остался прежним', after.body.order.delivery.code, delivered.delivery.code)
  c.eq('израсходован ровно 1 ключ', (await keysConsumed()) - before, 1)
  return c.checks
}
