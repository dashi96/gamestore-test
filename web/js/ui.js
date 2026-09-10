import { ApiError, getCart } from './api.js'

/** Общие мелочи страниц: значок живого потока, счётчик корзины, тексты ошибок. */

export function liveBadge() {
  const node = document.getElementById('live')
  return (status) => {
    if (!node) return
    node.dataset.status = status
    node.title = status === 'live' ? 'Витрина обновляется вживую' : 'Связь потеряна, переподключаемся'
  }
}

export async function cartBadge() {
  const node = document.getElementById('cart-count')
  if (!node) return
  try {
    const cart = await getCart()
    node.textContent = cart.items.length || ''
    node.hidden = cart.items.length === 0
  } catch {
    node.hidden = true
  }
}

export function errorText(error) {
  if (!(error instanceof ApiError)) return 'Что-то пошло не так'
  return (
    {
      promo_not_found: 'Промокод не найден',
      promo_limit_reached: 'Лимит промокода исчерпан',
      unknown_sku: 'Товар недоступен',
      unknown_offer: 'Предложение недоступно',
      sold_out: 'Товар только что раскупили',
      price_changed: 'Цена изменилась',
    }[error.code] ?? error.message
  )
}
