import { createOrder, getCart, money, removeFromCart, uuid } from './api.js'
import { applySnapshot, get, subscribe } from './store.js'
import { connect } from './stream.js'
import { toast } from './toast.js'
import { cartBadge, errorText, liveBadge } from './ui.js'

/**
 * Корзина.
 *
 * Цена здесь всегда действующая: она приезжает из того же потока, что и витрина.
 * Рядом показывается та, что покупатель видел, когда клал товар, — иначе после
 * перезагрузки страницы подорожание было бы незаметно, а ТЗ требует, чтобы новая
 * цена была видна ДО оплаты.
 *
 * На кнопке стоит сумма: нажатие по кнопке с ценой — осознанное согласие с ней.
 */

const host = document.getElementById('cart')
const totalNode = document.getElementById('cart-total')
const rows = new Map()
/** offer_id → цена на момент добавления. Только для показа «было столько». */
const seen = new Map()

init()

async function init() {
  connect(liveBadge(), load)
  subscribe((changed) => changed.forEach(paint))
  await load()
}

async function load() {
  const cart = await getCart()
  seen.clear()
  for (const item of cart.items) seen.set(item.offer_id, item.price_seen_rub)
  applySnapshot({ seq: cart.seq, offers: cart.items })
  render(cart.items)
  cartBadge()
}

function render(items) {
  host.textContent = ''
  rows.clear()

  if (!items.length) {
    host.innerHTML = '<p class="muted">Корзина пуста. <a href="index.html">Вернуться в каталог</a></p>'
    totalNode.textContent = ''
    return
  }

  for (const item of items) {
    const row = document.createElement('div')
    row.className = 'offer'
    row.innerHTML = `
      <div class="offer__seller">
        <b><a href="product.html?sku=${encodeURIComponent(item.sku)}"></a></b>
        <span class="offer__stock"></span>
      </div>
      <div class="offer__price">
        <span class="offer__now"></span>
        <span class="offer__was" hidden></span>
      </div>
      <div class="offer__actions">
        <button class="btn-ghost" data-act="drop">Убрать</button>
        <button class="btn-primary" data-act="buy"></button>
      </div>`
    row.querySelector('[data-act="drop"]').addEventListener('click', () => drop(item.offer_id))
    row.querySelector('[data-act="buy"]').addEventListener('click', (e) => buy(e.currentTarget, item.offer_id))
    host.append(row)
    rows.set(item.offer_id, row)
    paint(item.offer_id)
  }
  paintTotal()
}

function paint(offerId) {
  const row = rows.get(offerId)
  const offer = get(offerId)
  if (!row || !offer) return

  const sold = offer.available === 0
  const wasPrice = seen.get(offerId)
  const changed = wasPrice !== undefined && wasPrice !== offer.price_rub

  row.dataset.sold = String(sold)
  row.dataset.changed = String(changed)
  row.querySelector('.offer__seller a').textContent = `${offer.name} — ${offer.seller_name}`
  row.querySelector('.offer__stock').textContent = sold ? 'раскупили' : `в наличии: ${offer.available}`
  row.querySelector('.offer__now').textContent = money(offer.price_rub)

  const was = row.querySelector('.offer__was')
  was.hidden = !changed
  was.textContent = changed ? `было ${money(wasPrice)}` : ''

  const buyButton = row.querySelector('[data-act="buy"]')
  if (buyButton.dataset.busy !== 'true') {
    buyButton.textContent = sold ? 'Раскупили' : `Купить за ${money(offer.price_rub)}`
    buyButton.disabled = sold
  }
  paintTotal()
}

function paintTotal() {
  // Раскупленное в итог не входит: заплатить за него всё равно нельзя.
  const live = [...rows.keys()].map((id) => get(id)).filter((offer) => offer && offer.available > 0)
  const sum = live.reduce((total, offer) => total + offer.price_rub, 0)
  const sold = rows.size - live.length
  totalNode.textContent = rows.size
    ? `Итого по действующим ценам: ${money(sum)}${sold ? ` · раскуплено позиций: ${sold}` : ''}`
    : ''
}

async function drop(offerId) {
  try {
    await removeFromCart(offerId)
    await load()
  } catch (error) {
    toast(errorText(error), 'error')
  }
}

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
    // Заказ уже создан и держит единицу. Уборка корзины после этого — мелочь, и
    // её сбой не должен уводить в catch: там выдаётся новый ключ идемпотентности,
    // и следующее нажатие создало бы второй заказ на тот же товар.
    removeFromCart(offerId).catch(() => {})
    location.href = `order.html?id=${encodeURIComponent(order.id)}`
  } catch (error) {
    button.dataset.idempotencyKey = uuid()
    button.dataset.busy = 'false'
    if (error.code === 'price_changed') {
      // Цена успела уйти между отрисовкой и нажатием — показываем новую и
      // перерисовываем: заплатить по старой нельзя ни в каком случае.
      toast(`Цена изменилась: ${money(error.was_rub)} → ${money(error.now_rub)}`, 'error')
      await load()
      return
    }
    toast(errorText(error), 'error')
    paint(offerId)
  }
}
