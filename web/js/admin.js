import { request, money } from './api.js'
import { toast } from './toast.js'

const tokenInput = document.getElementById('token')
const token = () => tokenInput.value.trim()

const admin = (path, options = {}) =>
  request(path, { ...options, headers: { authorization: `Bearer ${token()}`, ...(options.headers ?? {}) } })

const STATUS_TEXT = {
  paid: 'оплачен',
  delivering: 'идёт выдача',
  out_of_stock: 'нет в наличии',
  delivery_failed: 'поставщики не смогли',
}

refresh()
setInterval(refresh, 2000)

document.getElementById('reset').addEventListener('click', async () => {
  await admin('/admin/reset', { method: 'POST' })
  toast('Состояние сброшено: заказы, события и остатки поставщиков')
  refresh()
})

/**
 * Витрина под управлением: цена и остаток любого предложения.
 *
 * Ровно этими двумя ручками показывается пункт 1 ТЗ — изменение видно во всех
 * открытых вкладках сразу. Список не перезагружается по таймеру, чтобы не сбивать
 * ввод: обновляется он по нажатию и после каждого изменения.
 */
document.getElementById('offer-find').addEventListener('click', findOffers)
document.getElementById('offer-search').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') findOffers()
})

async function findOffers() {
  const query = document.getElementById('offer-search').value.trim()
  const hint = document.getElementById('offer-hint')
  if (!query) {
    hint.textContent = 'Введите часть названия'
    return
  }
  const catalog = await request(`/api/catalog?q=${encodeURIComponent(query)}&limit=8`)
  hint.textContent = `Найдено товаров: ${catalog.total}`

  const rows = await Promise.all(
    catalog.offers.map(async (offer) => {
      const { offers } = await admin(`/admin/offers?sku=${encodeURIComponent(offer.sku)}`)
      return offers.map((row) => ({ ...row, name: offer.name }))
    }),
  )

  renderOffers(rows.flat())
}

function renderOffers(offers) {
  const table = document.getElementById('offers')
  table.innerHTML = `
    <tr><th>Товар</th><th>Продавец</th><th>Цена</th><th>Свободно</th><th></th></tr>
    ${offers
      .map(
        (offer) => `
      <tr>
        <td>${offer.name}</td>
        <td>${offer.seller_name}</td>
        <td><input class="price" data-id="${offer.id}" type="number" value="${offer.price_rub}" size="7" /></td>
        <td>${offer.free} из ${offer.units}</td>
        <td class="actions">
          <button class="btn-ghost" data-act="price" data-id="${offer.id}">Изменить цену</button>
          <button class="btn-ghost" data-act="stock" data-id="${offer.id}">+3 единицы</button>
        </td>
      </tr>`,
      )
      .join('')}`
}

// Один делегированный обработчик на таблицу: строки перерисовываются, он живёт.
document.getElementById('offers').addEventListener('click', onOfferAction)

async function onOfferAction(event) {
  const button = event.target.closest('button[data-act]')
  if (!button) return
  const id = Number(button.dataset.id)
  try {
    if (button.dataset.act === 'price') {
      const input = document.querySelector(`.price[data-id="${id}"]`)
      const result = await admin(`/admin/offers/${id}/price`, {
        method: 'POST',
        body: { price_rub: Number(input.value) },
      })
      toast(`Цена обновлена: ${money(result.price_rub)} — событие ${result.seq} ушло подписчикам`)
    } else {
      const result = await admin(`/admin/offers/${id}/stock`, { method: 'POST', body: { count: 3 } })
      toast(`Долито 3 единицы — событие ${result.seq} ушло подписчикам`)
    }
    await findOffers()
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function refresh() {
  try {
    const [orders, providers, stats] = await Promise.all([
      admin('/admin/orders?scope=stuck'),
      admin('/admin/providers'),
      admin('/admin/stats'),
    ])
    renderOrders(orders.orders)
    renderProviders(providers)
    renderStats(stats)
  } catch (error) {
    if (error.status === 401) document.getElementById('orders').innerHTML = '<tr><td>Неверный токен</td></tr>'
  }
}

function renderOrders(orders) {
  const table = document.getElementById('orders')
  if (!orders.length) {
    table.innerHTML = '<tr><td class="muted">Незавершённых выдач нет</td></tr>'
    return
  }

  table.innerHTML = `
    <tr>
      <th>Заказ</th><th>Товар</th><th>Статус</th><th>Сумма</th>
      <th>Поставщик</th><th>Попыток</th><th>Последняя ошибка</th><th></th>
    </tr>
    ${orders
      .map(
        (order) => `
      <tr>
        <td><a href="order.html?id=${order.id}">${order.id}</a></td>
        <td>${order.sku}</td>
        <td><span class="status" data-status="${order.status}">${STATUS_TEXT[order.status] ?? order.status}</span></td>
        <td>${money(order.total_rub)}</td>
        <td>${(order.job_provider ?? '—').toUpperCase()}</td>
        <td>${order.attempts ?? 0}</td>
        <td class="wrap muted">${order.last_error ?? ''}</td>
        <td><button class="btn-ghost" data-redeliver="${order.id}">Выдать повторно</button></td>
      </tr>`,
      )
      .join('')}`

  table.onclick = async (event) => {
    const button = event.target.closest('button[data-redeliver]')
    if (!button) return
    button.disabled = true
    const result = await admin(`/admin/orders/${button.dataset.redeliver}/redeliver`, { method: 'POST' })
    toast(result.alreadyDelivered ? 'Код уже был выдан — ничего не изменилось' : 'Повторная выдача поставлена в очередь')
    refresh()
  }
}

function renderProviders(providers) {
  const host = document.getElementById('providers')
  host.innerHTML = Object.entries(providers)
    .map(
      ([id, state]) => `
      <div style="margin-bottom:14px">
        <b>Поставщик ${id.toUpperCase()}</b>
        <div class="kv"><span>Остаток ключей</span><span>${state.stock}</span></div>
        <div class="kv"><span>Выдано / повторов</span><span>${state.stats.issued} / ${state.stats.replays}</span></div>
        <div class="kv"><span>Ошибок / таймаутов</span><span>${state.stats.errors} / ${state.stats.timeouts}</span></div>
        <div class="kv"><span>errorRate / timeoutRate</span><span>${state.config.errorRate} / ${state.config.timeoutRate}</span></div>
        <div class="actions">
          <button class="btn-ghost" data-stock="${id}">+5 ключей</button>
          <button class="btn-ghost" data-drain="${id}">Опустошить</button>
          <button class="btn-ghost" data-fail="${id}">Ломать (100% ошибок)</button>
          <button class="btn-ghost" data-hang="${id}">Вешать (100% таймаутов)</button>
          <button class="btn-ghost" data-heal="${id}">Починить</button>
        </div>
      </div>`,
    )
    .join('')

  host.onclick = async (event) => {
    const button = event.target.closest('button[data-stock], button[data-drain], button[data-fail], button[data-hang], button[data-heal]')
    if (!button) return
    const { stock, drain, fail, hang, heal } = button.dataset
    if (stock) await admin(`/admin/providers/${stock}/stock`, { method: 'POST', body: { count: 5 } })
    if (drain) await admin(`/admin/providers/${drain}/stock`, { method: 'POST', body: { drain: true } })
    if (fail) await admin(`/admin/providers/${fail}/config`, { method: 'POST', body: { errorRate: 1, timeoutRate: 0 } })
    if (hang) await admin(`/admin/providers/${hang}/config`, { method: 'POST', body: { errorRate: 0, timeoutRate: 1 } })
    if (heal) await admin(`/admin/providers/${heal}/config`, { method: 'POST', body: { errorRate: 0, timeoutRate: 0 } })
    refresh()
  }
}

function renderStats(stats) {
  document.getElementById('stats').innerHTML = `
    ${stats.orders_by_status
      .map((row) => `<div class="kv"><span>${row.status}</span><span>${row.count}</span></div>`)
      .join('')}
    <div class="kv"><span>Фактов выдачи</span><span>${stats.deliveries}</span></div>
    <div class="kv"><span>Уникальных кодов</span><span>${stats.distinct_codes}</span></div>
    <div class="kv"><span>Задач в очереди выдачи</span><span>${stats.pending_jobs}</span></div>
    <div class="kv"><span>Событий оплаты / необработанных</span><span>${stats.events.total} / ${stats.events.parked}</span></div>`
}
