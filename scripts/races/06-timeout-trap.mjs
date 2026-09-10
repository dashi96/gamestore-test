import { checker, createOrder, ensureStock, keysConsumed, pickOffer, providers, reset, setProvider, uid, waitForStatus, webhook } from './lib.mjs'

export const name = 'Ловушка таймаута и полный отказ поставщиков'

const providerA = process.env.PROVIDER_A_URL ?? 'http://localhost:4001'
const token = process.env.ADMIN_TOKEN ?? 'admin-token'

async function issuedByA() {
  const response = await fetch(`${providerA}/admin/issued`, { headers: { authorization: `Bearer ${token}` } })
  return (await response.json()).issued
}

const payFor = (order) =>
  webhook({
    event_id: uid('evt'),
    order_id: order.id,
    status: 'paid',
    amount: order.total_rub,
    currency: 'RUB',
  })

export async function run() {
  const c = checker()
  await reset()

  // ── Часть 1. Поставщик A выдаёт код и «зависает»: ответ не доходит.
  await setProvider('a', { errorRate: 0, timeoutRate: 1 })
  await setProvider('b', { errorRate: 0, timeoutRate: 0 })

  // Код выдаёт поставщик продавца, а не всегда A. Сценарий про поведение A,
  // поэтому продавца выбираем осознанно, а не отдаём на волю самой дешёвой цены.
  await ensureStock('KEY-GTA5', 4)
  const offer = await pickOffer('KEY-GTA5', { provider: 'a' })

  const before = await keysConsumed()
  const order = (await createOrder(null, { key: uid('trap'), offerId: offer.id })).body
  await payFor(order)

  // Повтор идёт с тем же request_id, поставщик обязан вернуть тот же код —
  // поэтому заказ доезжает до выдачи сам, без вмешательства.
  const delivered = await waitForStatus(order.id, ['delivered'], 60_000)
  const state = await providers()
  const issued = await issuedByA()

  c.eq('заказ выдан, несмотря на таймаут', delivered.status, 'delivered')
  c.eq('израсходован ровно один ключ', (await keysConsumed()) - before, 1)
  c.eq('поставщик A закрепил ровно один код', state.a.issued, 1)
  c.ok('клиент получил тот самый код, что ушёл в «зависший» ответ',
    Object.values(issued).includes(delivered.delivery.code), delivered.delivery.code)
  c.ok('повтор пришёл с тем же request_id', state.a.stats.replays >= 1, `replays=${state.a.stats.replays}`)
  c.eq('к резервному поставщику не ушли: исход был неоднозначным', state.b.stats.requests, 0)
  c.eq('ключей у B не тронуто', state.b.stats.issued, 0)

  // ── Часть 2. Оба поставщика отвечают 5xx: выдать некому.
  await setProvider('a', { errorRate: 1, timeoutRate: 0 })
  await setProvider('b', { errorRate: 1, timeoutRate: 0 })

  const beforeFail = await keysConsumed()
  const second = (await createOrder(null, { key: uid('fail'), offerId: offer.id })).body
  await payFor(second)

  const failed = await waitForStatus(second.id, ['delivery_failed'], 60_000)
  c.eq('заказ в восстановимом состоянии, а не потерян', failed.status, 'delivery_failed')
  c.eq('на отказах ключи не расходуются', (await keysConsumed()) - beforeFail, 0)

  // Поставщик ожил — заказ доедет сам, без ручного вмешательства.
  await setProvider('a', { errorRate: 0 })
  const recovered = await waitForStatus(second.id, ['delivered'], 90_000)
  c.eq('после восстановления заказ выдан', recovered.status, 'delivered')
  c.eq('и ровно одним ключом', (await keysConsumed()) - beforeFail, 1)
  c.ok('коды двух заказов разные', recovered.delivery.code !== delivered.delivery.code,
    `${delivered.delivery.code} / ${recovered.delivery.code}`)
  return c.checks
}
