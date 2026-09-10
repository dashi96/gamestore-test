import { adminOffers, cartClient, checker, ensureStock, reset, setPrice, uid } from './lib.mjs'

export const name = 'Товар подорожал, пока лежал в корзине: новая цена видна до оплаты, а не после'

const SKU = 'GIFT-ROBLOX-800'

export async function run() {
  const c = checker()
  await reset()
  await ensureStock(SKU, 4)
  const [offer] = await adminOffers(SKU)

  // «Браузер» покупателя: корзина привязана к httpOnly-cookie.
  const buyer = cartClient()
  const put = await buyer('/api/cart', { method: 'POST', body: { offer_id: offer.id } })
  c.eq('товар положен в корзину', put.status, 200)

  const seen = put.body.items[0].price_seen_rub
  c.eq('в корзине одна позиция', put.body.items.length, 1)
  c.eq('цена в корзине — цена продавца', seen, offer.price_rub)
  c.eq('изменения ещё нет', put.body.items[0].price_changed, false)

  // Продавец поднял цену, пока товар лежал в корзине.
  const raised = seen + 700
  await setPrice(offer.id, raised)

  const reopened = await buyer('/api/cart')
  const item = reopened.body.items[0]
  c.eq('корзина показывает новую цену', item.price_rub, raised)
  c.eq('и помечает, что цена изменилась', item.price_changed, true)
  c.eq('прежняя цена сохранена для показа', item.price_seen_rub, seen)
  c.eq('итог считается по действующей цене', reopened.body.total_rub, raised)

  // Попытка оформить по старой цене — отказ ДО оплаты, с новой ценой в ответе.
  const stale = await buyer('/api/orders', {
    method: 'POST',
    body: { offer_id: offer.id, expected_price_rub: seen },
  })
  c.eq('оформить по прежней цене нельзя', stale.status, 409)
  c.eq('и отказ говорит почему', stale.body.error, 'price_changed')
  c.eq('в отказе видна прежняя цена', stale.body.was_rub, seen)
  c.eq('и новая', stale.body.now_rub, raised)

  // Согласие с новой ценой — заказ проходит, и сумма именно новая.
  const fresh = await buyer('/api/orders', {
    method: 'POST',
    body: { offer_id: offer.id, expected_price_rub: raised },
  })
  c.eq('по новой цене заказ создаётся', fresh.status, 201)
  c.eq('сумма заказа — новая цена', fresh.body.total_rub, raised)

  // Подешевение отказом не является: отказывать покупателю из-за скидки незачем.
  await setPrice(offer.id, raised - 400)
  const cheaper = await buyer('/api/orders', {
    method: 'POST',
    body: { offer_id: offer.id, expected_price_rub: raised },
  })
  c.eq('подешевевший товар проходит молча', cheaper.status, 201)
  c.eq('и списывается по новой, меньшей цене', cheaper.body.total_rub, raised - 400)
  return c.checks
}
