import { checker, createOrder, keysConsumed, reset, setProvider, stats, uid, waitForStatus, webhook } from './lib.mjs'

export const name = 'Шторм вебхуков: 50 параллельных «оплачено» по одному заказу (один event_id и 50 разных)'

async function storm({ sameEvent }) {
  const order = (await createOrder('KEY-GTA5', { key: uid('storm') })).body
  const eventId = uid('evt')

  const before = await keysConsumed()
  await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      webhook({
        event_id: sameEvent ? eventId : `${eventId}_${i}`,
        order_id: order.id,
        status: 'paid',
        amount: order.total_rub,
        currency: 'RUB',
        created_at: new Date().toISOString(),
      }),
    ),
  )

  const final = await waitForStatus(order.id, ['delivered'])
  return { order: final, consumed: (await keysConsumed()) - before }
}

export async function run() {
  const c = checker()
  await reset()
  // Убираем случайные отказы: проверяем гонку, а не устойчивость к сбоям.
  await Promise.all([setProvider('a', { errorRate: 0, timeoutRate: 0 }), setProvider('b', { errorRate: 0, timeoutRate: 0 })])

  const same = await storm({ sameEvent: true })
  c.eq('один event_id ×50 → заказ выдан', same.order.status, 'delivered')
  c.eq('один event_id ×50 → израсходован 1 ключ', same.consumed, 1)

  const distinct = await storm({ sameEvent: false })
  c.eq('50 разных event_id → заказ выдан', distinct.order.status, 'delivered')
  c.eq('50 разных event_id → израсходован 1 ключ', distinct.consumed, 1)

  const s = await stats()
  c.eq('фактов выдачи всего', s.deliveries, 2)
  c.eq('ни один ключ не ушёл в два заказа', s.distinct_codes, s.deliveries)
  return c.checks
}
