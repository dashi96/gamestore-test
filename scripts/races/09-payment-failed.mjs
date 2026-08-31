import { checker, createOrder, getOrder, keysConsumed, reset, setProvider, uid, waitForStatus, webhook } from './lib.mjs'

export const name = 'Неуспешная оплата: возврат промокода, приоритет paid над failed в обе стороны'

const send = (order, status, eventId = uid('evt')) =>
  webhook({
    event_id: eventId,
    order_id: order.id,
    status,
    amount: order.total_rub,
    currency: 'RUB',
  })

export async function run() {
  const c = checker()
  await reset()
  await setProvider('a', { errorRate: 0, timeoutRate: 0 })

  // ── Оплата не прошла: заказ финализируется, промокод возвращается в лимит.
  const first = (await createOrder('KEY-GTA5', { key: uid('fail'), promo: 'ONCEONLY' })).body
  c.eq('промокод применён к первому заказу', first.promo_code, 'ONCEONLY')

  const blocked = await createOrder('KEY-GTA5', { key: uid('blocked'), promo: 'ONCEONLY' })
  c.eq('пока заказ жив, лимит занят', blocked.body.error, 'promo_limit_reached')

  const failEvent = uid('evt')
  await send(first, 'failed', failEvent)
  const failed = await waitForStatus(first.id, ['payment_failed'])
  c.eq('заказ в payment_failed', failed.status, 'payment_failed')

  const reused = await createOrder('KEY-GTA5', { key: uid('reuse'), promo: 'ONCEONLY' })
  c.eq('после отказа оплаты промокод снова доступен', reused.status, 201)
  c.eq('и скидка та же', reused.body.discount_rub, 995)

  // Повтор того же события ничего не меняет и не возвращает промокод дважды.
  const repeat = await send(first, 'failed', failEvent)
  c.eq('повтор отказа — дубль', repeat.body.result, 'duplicate')

  const blockedAgain = await createOrder('KEY-GTA5', { key: uid('again'), promo: 'ONCEONLY' })
  c.eq('лимит не «протёк» на повторе', blockedAgain.body.error, 'promo_limit_reached')

  // ── Успешная оплата сильнее отказа, даже если отказ пришёл позже.
  const second = (await createOrder('KEY-CS2-PRIME', { key: uid('order') })).body
  await send(second, 'paid')
  const delivered = await waitForStatus(second.id, ['delivered'])

  await send(second, 'failed')
  const afterLateFailure = (await getOrder(second.id)).body

  c.eq('заказ выдан', delivered.status, 'delivered')
  c.eq('поздний failed не отменяет выдачу', afterLateFailure.status, 'delivered')
  c.eq('код на месте', afterLateFailure.delivery.code, delivered.delivery.code)

  // ── Обратный порядок: сначала пришёл отказ, потом успешная оплата.
  // Так бывает при ретраях платёжной системы, и деньги важнее записанного отказа.
  const third = (await createOrder('KEY-EFT', { key: uid('revive') })).body
  await send(third, 'failed')
  await waitForStatus(third.id, ['payment_failed'])
  await send(third, 'paid')
  const revived = await waitForStatus(third.id, ['delivered'])

  c.eq('paid после failed поднимает заказ и доводит до выдачи', revived.status, 'delivered')
  c.ok('код выдан', Boolean(revived.delivery?.code), revived.delivery?.code)

  const beforeKeys = await keysConsumed()
  await send(third, 'paid')
  await send(third, 'failed')
  const settled = (await getOrder(third.id)).body
  c.eq('дальнейшие вебхуки ничего не меняют', settled.status, 'delivered')
  c.eq('и ключей не расходуют', (await keysConsumed()) - beforeKeys, 0)

  // ── Отказ по неоплаченному заказу остаётся финальным.
  const finalOrder = (await getOrder(first.id)).body
  c.eq('payment_failed без последующей оплаты остаётся финальным', finalOrder.status, 'payment_failed')
  c.eq('кода по неоплаченному заказу нет', finalOrder.delivery, null)
  return c.checks
}
