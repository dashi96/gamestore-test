import { getOrder, money, payOrder } from './api.js'
import { toast } from './toast.js'

const STATUS_TEXT = {
  created: 'Ожидает оплаты',
  paid: 'Оплачен, готовим выдачу',
  delivering: 'Получаем код у поставщика',
  delivered: 'Код выдан',
  payment_failed: 'Оплата не прошла',
  out_of_stock: 'Оплачено, но кода нет в наличии',
  delivery_failed: 'Поставщики не смогли выдать код',
}

const RECOVERABLE = new Set(['out_of_stock', 'delivery_failed'])

const orderId = new URLSearchParams(location.search).get('id')
const panel = document.getElementById('order-panel')
const log = document.getElementById('pay-log')

if (!orderId) {
  panel.innerHTML = '<p class="muted">Не указан номер заказа.</p>'
} else {
  render()
  // Опрос статуса: выдача идёт в фоне, страница показывает её ход.
  setInterval(render, 1000)
}

document.getElementById('pay-success').addEventListener('click', (e) => pay(e, 'success', 1))
document.getElementById('pay-failure').addEventListener('click', (e) => pay(e, 'failure', 1))
document.getElementById('pay-storm').addEventListener('click', (e) => pay(e, 'success', 50))

async function pay(event, outcome, copies) {
  const button = event.currentTarget
  button.disabled = true
  try {
    const result = await payOrder(orderId, outcome, copies)
    const counts = result.results.reduce((acc, r) => ({ ...acc, [r]: (acc[r] ?? 0) + 1 }), {})
    addLog(
      `Отправлено ${result.sent} вебхук(ов), event_id ${result.event_id}`,
      Object.entries(counts)
        .map(([key, count]) => `${key}: ${count}`)
        .join(', '),
    )
    await render()
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

async function render() {
  let order
  try {
    order = await getOrder(orderId)
  } catch {
    panel.innerHTML = '<p class="muted">Заказ не найден.</p>'
    return
  }

  panel.innerHTML = `
    <h1>Заказ ${order.id}</h1>
    <p class="muted">${order.product?.name ?? order.sku}</p>
    <p><span class="status" data-status="${order.status}">${STATUS_TEXT[order.status] ?? order.status}</span></p>

    ${order.delivery ? `<div class="code">${order.delivery.code}</div>` : ''}

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
