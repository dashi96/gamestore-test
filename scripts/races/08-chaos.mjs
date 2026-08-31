import { checker, createOrder, keysConsumed, reset, setProvider, stats, uid, waitForStatus, webhook } from './lib.mjs'

export const name = 'Хаос: 10 заказов параллельно при 50% ошибок и 30% таймаутов у обоих поставщиков'

const ORDERS = 10

export async function run() {
  const c = checker()
  await reset()
  await Promise.all([
    setProvider('a', { errorRate: 0.5, timeoutRate: 0.3, latencyMs: 20 }),
    setProvider('b', { errorRate: 0.5, timeoutRate: 0.3, latencyMs: 20 }),
  ])

  const before = await keysConsumed()
  const orders = await Promise.all(
    Array.from({ length: ORDERS }, () => createOrder('KEY-GTA5', { key: uid('chaos') })),
  )

  // По каждому заказу — три параллельных вебхука с разными event_id.
  await Promise.all(
    orders.flatMap(({ body }) =>
      Array.from({ length: 3 }, () =>
        webhook({
          event_id: uid('evt'),
          order_id: body.id,
          status: 'paid',
          amount: body.total_rub,
          currency: 'RUB',
        }),
      ),
    ),
  )

  const settled = await Promise.all(
    orders.map(({ body }) => waitForStatus(body.id, ['delivered'], 90_000)),
  )

  const codes = new Set(settled.map((o) => o.delivery.code))
  const s = await stats()

  c.eq('все заказы доведены до выдачи', settled.length, ORDERS)
  c.eq('у каждого свой уникальный код', codes.size, ORDERS)
  c.eq('фактов выдачи ровно по числу заказов', s.deliveries, ORDERS)
  c.eq('одинаковых кодов в базе нет', s.distinct_codes, s.deliveries)
  c.eq('ключей израсходовано ровно по числу заказов', (await keysConsumed()) - before, ORDERS)
  c.eq('очередь выдачи разобрана до конца', s.pending_jobs, 0)
  c.eq('необработанных событий не осталось', s.events.parked, 0)
  return c.checks
}
