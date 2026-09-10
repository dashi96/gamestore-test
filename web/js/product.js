import { addToCart, createOrder, getOffers, money, uuid } from './api.js'
import { applySnapshot, get, subscribe } from './store.js'
import { connect } from './stream.js'
import { toast } from './toast.js'
import { cartBadge, errorText, liveBadge } from './ui.js'

/**
 * Карточка товара: все продавцы с живыми ценами и остатком.
 *
 * Это же экран из пункта 2.2 ТЗ — проигравшему гонку есть куда вернуться и у
 * кого взять то же самое. Строки не пересоздаются: меняется только цена, остаток
 * и состояние кнопки.
 */

const sku = new URLSearchParams(location.search).get('sku')
const rows = new Map()
const host = document.getElementById('offers')
const title = document.getElementById('product-title')

init()

async function init() {
  if (!sku) {
    host.innerHTML = '<p class="muted">Не указан товар.</p>'
    return
  }
  cartBadge()
  connect(liveBadge(), load)
  subscribe((changed) => changed.forEach(paint))

  await load()
}

async function load() {
  try {
    const snapshot = await getOffers(sku)
    applySnapshot(snapshot)
    render(snapshot.offers)
  } catch {
    host.innerHTML = '<p class="muted">Товар не найден.</p>'
  }
}

function render(offers) {
  if (!offers.length) {
    host.innerHTML = '<p class="muted">Предложений нет.</p>'
    return
  }
  title.textContent = offers[0].name
  document.title = offers[0].name
  document.getElementById('product-image').src = offers[0].image
  host.textContent = ''
  rows.clear()

  for (const offer of offers) {
    const row = document.createElement('div')
    row.className = 'offer'
    row.innerHTML = `
      <div class="offer__seller"><b></b><span class="offer__stock"></span></div>
      <div class="offer__price"></div>
      <div class="offer__actions">
        <button class="btn-ghost" data-act="cart">В корзину</button>
        <button class="btn-primary" data-act="buy">Купить</button>
      </div>`
    row.querySelector('[data-act="cart"]').addEventListener('click', (e) => intoCart(e.currentTarget, offer.offer_id))
    row.querySelector('[data-act="buy"]').addEventListener('click', (e) => buy(e.currentTarget, offer.offer_id))
    host.append(row)
    rows.set(offer.offer_id, row)
    paint(offer.offer_id)
  }
}

function paint(offerId) {
  const row = rows.get(offerId)
  const offer = get(offerId)
  if (!row || !offer) return

  const sold = offer.available === 0
  row.dataset.sold = String(sold)
  row.querySelector('.offer__seller b').textContent = offer.seller_name
  row.querySelector('.offer__stock').textContent = sold ? 'раскупили' : `в наличии: ${offer.available}`
  row.querySelector('.offer__price').textContent = money(offer.price_rub)
  for (const button of row.querySelectorAll('button')) button.disabled = sold
}

async function intoCart(button, offerId) {
  button.disabled = true
  try {
    await addToCart(offerId)
    await cartBadge()
    toast('Добавлено в корзину')
  } catch (error) {
    toast(errorText(error), 'error')
  } finally {
    button.disabled = get(offerId)?.available === 0
  }
}

/**
 * Покупка у выбранного продавца. Ключ идемпотентности выдаётся один на кнопку и
 * не меняется до ответа: двойной клик даёт один заказ, а не два. Вместе с
 * заказом уходит цена с экрана — подорожание сервер отклонит до оплаты.
 */
async function buy(button, offerId) {
  if (button.dataset.busy === 'true') return
  button.dataset.busy = 'true'
  button.disabled = true
  button.textContent = 'Бронируем…'
  button.dataset.idempotencyKey ??= uuid()

  try {
    const order = await createOrder(
      { offerId, expectedPrice: get(offerId)?.price_rub ?? null },
      { idempotencyKey: button.dataset.idempotencyKey },
    )
    location.href = `order.html?id=${encodeURIComponent(order.id)}`
  } catch (error) {
    button.dataset.idempotencyKey = uuid()
    button.dataset.busy = 'false'
    button.textContent = 'Купить'
    button.disabled = false
    if (error.code === 'sold_out') {
      // Пункт 2.2 ТЗ: понятный отказ и предложение другого продавца.
      const other = (error.alternatives ?? [])[0]
      toast(
        other
          ? `Товар только что раскупили. Есть у ${other.seller_name} за ${money(other.price_rub)}`
          : 'Товар только что раскупили',
        'error',
      )
    } else if (error.code === 'price_changed') {
      toast(`Цена изменилась: ${money(error.was_rub)} → ${money(error.now_rub)}`, 'error')
    } else {
      toast(errorText(error), 'error')
    }
  }
}
