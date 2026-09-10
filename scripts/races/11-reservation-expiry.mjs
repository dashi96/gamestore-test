import {
  adminOffers, checker, createOrder, ensureStock, expireReservation, freeUnits,
  getOrder, openStream, reset, uid, waitUntil,
} from './lib.mjs'

export const name = 'Бронь с таймером: по истечении товар возвращается в продажу для всех'

const SKU = 'SUB-DISCORD-1M'

export async function run() {
  const c = checker()
  await reset()
  await ensureStock(SKU, 4)
  const [offer] = await adminOffers(SKU)

  const watcher = await openStream()
  const before = await freeUnits(SKU, offer.id)

  const created = await createOrder(null, { key: uid('hold'), offerId: offer.id })
  const order = created.body
  c.eq('заказ создан', created.status, 201)
  c.ok('бронь отдана клиенту вместе с заказом', Boolean(order.reservation), JSON.stringify(order.reservation))
  c.ok('и у неё есть срок', Boolean(order.reservation?.expires_at), order.reservation?.expires_at)
  c.ok('сервер прислал своё время — по нему клиент считает поправку часов',
    Boolean(order.server_now), order.server_now)

  const held = await freeUnits(SKU, offer.id)
  c.eq('бронь заняла единицу', held, before - 1)

  const afterHold = await waitUntil(
    async () => watcher.latest(offer.id),
    (state) => state?.available === before - 1,
    { timeoutMs: 3000 },
  )
  c.eq('подписчики увидели уменьшившийся остаток', afterHold?.available, before - 1)

  // Приближаем срок; снимает бронь развёртка в воркере, а не эта ручка.
  await expireReservation(order.id)

  const expired = await waitUntil(
    async () => (await getOrder(order.id)).body,
    (o) => o.status === 'reservation_expired',
    { timeoutMs: 8000 },
  )
  c.eq('заказ помечен истёкшей бронью', expired.status, 'reservation_expired')
  c.eq('причина зафиксирована', expired.status_reason, 'expired')
  c.ok('брони в ответе больше нет', expired.reservation === null, JSON.stringify(expired.reservation))
  c.eq('товар вернулся в продажу', await freeUnits(SKU, offer.id), before)

  const afterRelease = await waitUntil(
    async () => watcher.latest(offer.id),
    (state) => state?.available === before,
    { timeoutMs: 5000 },
  )
  c.eq('и подписчики увидели это без перезагрузки', afterRelease?.available, before)

  watcher.close()
  return c.checks
}
