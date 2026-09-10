import { getOrder, money, payOrder } from './api.js'
import { toast } from './toast.js'

const STATUS_TEXT = {
  created: 'Забронировано, ожидает оплаты',
  awaiting_payment: 'Платёж в пути',
  paid: 'Оплачен, готовим выдачу',
  delivering: 'Получаем код у поставщика',
  delivered: 'Код выдан',
  payment_failed: 'Оплата не прошла',
  out_of_stock: 'Оплачено, но товара нет в наличии',
  delivery_failed: 'Поставщики не смогли выдать код',
  reservation_expired: 'Бронь снята: время вышло',
}

const RECOVERABLE = new Set(['out_of_stock', 'delivery_failed'])

const orderId = new URLSearchParams(location.search).get('id')
const panel = document.getElementById('order-panel')
const log = document.getElementById('pay-log')

/**
 * Расхождение часов браузера и сервера. Сервер отдаёт момент истечения брони и
 * своё текущее время, поправка считается один раз — тогда уснувшая в фоне
 * вкладка после пробуждения показывает правду сразу, а не после первого ответа.
 *
 * Решение об истечении принимает только сервер. Отсчёт на экране — показ.
 */
let clockOffsetMs = 0
let current = null

if (!orderId) {
  panel.innerHTML = '<p class="muted">Не указан номер заказа.</p>'
} else {
  refresh()
  // Статус заказа в поток витрины не входит: он про предложения, а не про заказы.
  setInterval(refresh, 1000)
  setInterval(tick, 250)
  document.addEventListener('visibilitychange', () => !document.hidden && refresh())
}

for (const [id, outcome, copies, delay] of [
  ['pay-success', 'success', 1, 0],
  ['pay-failure', 'failure', 1, 0],
  ['pay-storm', 'success', 50, 0],
  ['pay-slow', 'success', 1, 5000],
]) {
  document.getElementById(id)?.addEventListener('click', (e) => pay(e, outcome, copies, delay))
}

async function pay(event, outcome, copies, delayMs) {
  const button = event.currentTarget
  button.disabled = true
  try {
    const result = await payOrder(orderId, outcome, copies, delayMs)
    const counts = (result.results ?? []).reduce((acc, r) => ({ ...acc, [r]: (acc[r] ?? 0) + 1 }), {})
    addLog(
      `Отправлено ${result.sent} вебхук(ов), event_id ${result.event_id}`,
      result.scheduled_in_ms
        ? `придёт через ${result.scheduled_in_ms} мс — бронь обязана дожить`
        : Object.entries(counts).map(([key, count]) => `${key}: ${count}`).join(', '),
    )
    await refresh()
  } catch (error) {
    toast(error.message, 'error')
  } finally {
    button.disabled = false
  }
}

function addLog(title, detail) {
  const row = document.createElement('div')
  row.className = 'row'
  row.innerHTML = `<span>${title}</span><span class="muted">${detail}</span>`
  log.prepend(row)
}

async function refresh() {
  try {
    current = await getOrder(orderId)
  } catch {
    panel.innerHTML = '<p class="muted">Заказ не найден.</p>'
    return
  }
  clockOffsetMs = Date.parse(current.server_now) - Date.now()
  render()
  tick()
}

function render() {
  const order = current
  panel.innerHTML = `
    <h1>Заказ ${order.id}</h1>
    <p class="muted">${order.product?.name ?? order.sku}${
      order.offer ? ` · продавец ${order.offer.seller_name}` : ''
    }</p>
    <p><span class="status" data-status="${order.status}">${STATUS_TEXT[order.status] ?? order.status}</span></p>

    ${order.reservation ? '<div class="countdown" id="countdown"></div>' : ''}
    ${order.delivery ? `<div class="code">${order.delivery.code}</div>` : ''}

    ${
      order.status === 'reservation_expired'
        ? `<p class="muted">Товар вернулся в продажу и доступен всем.
             <a href="product.html?sku=${encodeURIComponent(order.sku)}">Посмотреть предложения</a>.
             Если оплата всё-таки придёт, заказ подхватит свободную единицу того же продавца.</p>`
        : ''
    }
    ${
      RECOVERABLE.has(order.status)
        ? `<p class="muted">Состояние восстановимое: деньги учтены, заказ ждёт выдачи.
             Он в списке «оплачен, но не выдан» в <a href="admin.html">админке</a>,
             повторная выдача безопасна и не задваивает ключ.</p>`
        : ''
    }

    <div class="rows">
      <div class="row"><span>Цена</span><span>${money(order.amount_rub)}</span></div>
      ${
        order.discount_rub
          ? `<div class="row"><span>Скидка по промокоду ${order.promo_code}</span><span>−${money(order.discount_rub)}</span></div>`
          : ''
      }
      <div class="row"><span>К оплате</span><span><b>${money(order.total_rub)}</b></span></div>
      ${
        order.delivery
          ? `<div class="row"><span>Поставщик</span><span>${order.delivery.provider.toUpperCase()}</span></div>`
          : ''
      }
      ${
        order.status_reason
          ? `<div class="row"><span>Причина</span><span class="muted">${order.status_reason}</span></div>`
          : ''
      }
    </div>`
}

/** Только отсчёт: перерисовывать ради него всю панель незачем. */
function tick() {
  const node = document.getElementById('countdown')
  if (!node || !current?.reservation) return

  // Пока заказ ждёт платёж, развёртка смотрит не на обычный срок, а на потолок.
  // Показывать в это время «время вышло» значило бы пугать покупателя ровно там,
  // где товар за ним как раз закреплён.
  const deadline =
    current.status === 'awaiting_payment'
      ? current.reservation.hard_expires_at
      : current.reservation.expires_at
  const leftMs = Date.parse(deadline) - (Date.now() + clockOffsetMs)
  if (leftMs <= 0) {
    node.dataset.state = 'over'
    node.textContent = 'Время брони вышло, снимаем…'
    return
  }
  const seconds = Math.ceil(leftMs / 1000)
  node.dataset.state = seconds <= 60 ? 'soon' : 'ok'
  const clock = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  node.textContent =
    current.status === 'awaiting_payment'
      ? `Ждём подтверждение оплаты, товар закреплён: ${clock}`
      : `Товар забронирован: ${clock}`
}
