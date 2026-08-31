import { admin, checker, createOrder, keysConsumed, providers, reset, setProvider, setStock, sleep, uid, waitForStatus, webhook } from './lib.mjs'

export const name = 'Пустой пул: оплата прошла, ключей нет — восстановимое состояние и ручная перевыдача'

export async function run() {
  const c = checker()
  await reset()
  await Promise.all([
    setProvider('a', { errorRate: 0, timeoutRate: 0 }),
    setProvider('b', { errorRate: 0, timeoutRate: 0 }),
    setStock('a', { drain: true }),
    setStock('b', { drain: true }),
  ])

  const order = (await createOrder('KEY-EFT', { key: uid('oos') })).body
  await webhook({
    event_id: uid('evt'),
    order_id: order.id,
    status: 'paid',
    amount: order.total_rub,
    currency: 'RUB',
  })

  const stuck = await waitForStatus(order.id, ['out_of_stock'])
  c.eq('заказ ушёл в восстановимое состояние', stuck.status, 'out_of_stock')
  c.eq('причина зафиксирована', stuck.status_reason, 'both_providers_out_of_stock')

  const health = await fetch(`${process.env.API_URL ?? 'http://localhost:3000'}/health`)
  c.eq('сервис жив, а не упал', health.status, 200)

  const stuckList = (await admin('/admin/orders?scope=stuck')).body.orders
  c.ok('заказ виден в админке как «оплачен, но не выдан»', stuckList.some((o) => o.id === order.id))

  // Пополняем остаток и жмём «выдать повторно».
  const before = await keysConsumed()
  await setStock('a', { count: 5 })
  await admin(`/admin/orders/${order.id}/redeliver`, { method: 'POST' })

  const delivered = await waitForStatus(order.id, ['delivered'])
  c.eq('после пополнения заказ выдан', delivered.status, 'delivered')
  c.ok('код на месте', Boolean(delivered.delivery?.code), delivered.delivery?.code)
  c.eq('повторная выдача взяла ровно 1 ключ', (await keysConsumed()) - before, 1)

  // Идемпотентность ручной перевыдачи: жмём ещё три раза.
  const repeats = await Promise.all(
    Array.from({ length: 3 }, () => admin(`/admin/orders/${order.id}/redeliver`, { method: 'POST' })),
  )
  await sleep(1500)
  const after = await waitForStatus(order.id, ['delivered'])

  c.ok('повторные нажатия отвечают «уже выдан»', repeats.every((r) => r.body.alreadyDelivered === true))
  c.eq('код не изменился', after.delivery.code, delivered.delivery.code)
  c.eq('лишних ключей не израсходовано', (await keysConsumed()) - before, 1)

  const state = await providers()
  c.ok('остаток поставщика уменьшился ровно на выданное', state.a.stats.issued === 1, `issued=${state.a.stats.issued}`)
  return c.checks
}
