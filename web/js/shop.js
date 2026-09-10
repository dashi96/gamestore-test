import { createOrder, money, quotePromo, request, uuid } from './api.js'
import { initCarousel } from './carousel.js'
import { initCatalog } from './catalog.js'
import { initCurrency } from './currency.js'
import { createGate } from './requests.js'
import { applySnapshot, get, subscribe } from './store.js'
import { connect } from './stream.js'
import { toast } from './toast.js'
import { cartBadge, liveBadge, errorText } from './ui.js'

const SERVICES = [
  { name: 'Steam', image: 'assets/services/steam.png' },
  { name: 'Telegram', image: 'assets/services/telegram.png' },
  { name: 'Roblox', image: 'assets/services/roblox.png' },
  { name: 'Brawl Stars', image: 'assets/services/brawl-stars.png' },
  { name: 'PUBG Mobile', image: 'assets/services/pubg-mobile.png' },
  { name: 'App Store', image: 'assets/services/app-store.png' },
  { name: 'ChatGPT', image: 'assets/services/chatgpt.png' },
  { name: 'PlayStation', image: 'assets/services/playstation.png' },
  { name: 'TikTok', image: 'assets/services/tiktok.png' },
  { name: 'Mobile Legends', image: 'assets/services/mobile-legends.png' },
]

const SLIDES = [
  {
    title: 'Пополнение Steam за 3 минуты',
    text: 'Комиссия 5%, зачисление автоматическое — сразу после подтверждения оплаты.',
    background: 'linear-gradient(120deg, #0f1116 0%, #1d2a44 100%)',
  },
  {
    title: 'Остаток на витрине настоящий',
    text: 'Цена и наличие меняются в тот же момент, когда товар разбирают у продавца.',
    background: 'linear-gradient(120deg, #171018 0%, #4a1e3d 100%)',
  },
  {
    title: 'Бронь на 7 минут',
    text: 'При оформлении товар закрепляется за вами, а на экране идёт обратный отсчёт.',
    background: 'linear-gradient(120deg, #101815 0%, #1f4536 100%)',
  },
  {
    title: 'Несколько продавцов на один товар',
    text: 'Раскупили у одного — на карточке товара сразу видно предложения остальных.',
    background: 'linear-gradient(120deg, #14121b 0%, #3a2a63 100%)',
  },
]

/** Вкладки соответствуют типам товаров: в первом этапе они были декоративными. */
const TABS = [
  { label: 'Все', type: null },
  { label: 'Донат', type: 'topup' },
  { label: 'Подписки', type: 'subscription' },
  { label: 'Ключи', type: 'key' },
  { label: 'Гифт-карты', type: 'giftcard' },
  { label: 'Игровая валюта', type: 'currency' },
]

/** Промокод живёт в памяти страницы: на сервер уходит только его код. */
let activePromo = null

/** offer_id → карточка. Узлы не пересоздаются, меняется только то, что изменилось. */
const cards = new Map()

/**
 * Состояние поиска целиком лежит в адресе страницы: по прямой ссылке
 * открывается ровно та же выдача (пункт 5.3 ТЗ).
 */
const filters = { q: '', type: null, min: null, max: null, sort: null }

const gate = createGate()
let inFlight = null
let debounce = null

init()

async function init() {
  initCatalog({
    button: document.getElementById('catalog-btn'),
    menu: document.getElementById('catalog-menu'),
  })
  initCarousel({
    track: document.getElementById('banner-track'),
    dots: document.getElementById('banner-dots'),
    prev: document.getElementById('banner-prev'),
    next: document.getElementById('banner-next'),
    slides: SLIDES,
  })
  initCurrency(document.getElementById('currency'))
  renderServices()
  renderTabs()
  initPromo()
  cartBadge()

  document.getElementById('topup-buy').addEventListener('click', (event) => buyBySku(event.currentTarget))

  readFilters()
  initFilters()
  selectTab()
  connect(liveBadge(), () => search({ immediate: true }))
  subscribe(repaint)
  search({ immediate: true })
}

function readFilters() {
  const params = new URLSearchParams(location.search)
  filters.q = params.get('q') ?? ''
  filters.type = params.get('type') || null
  filters.min = params.get('min') || null
  filters.max = params.get('max') || null
  filters.sort = params.get('sort') || null
}

function writeFilters() {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value)
  const query = params.toString()
  // replaceState, а не pushState: набор запроса побуквенно не должен забивать
  // историю браузера — «Назад» обязан вести на предыдущую страницу.
  history.replaceState(null, '', query ? `?${query}` : location.pathname)
}

/**
 * Запуск поиска. Пауза перед отправкой гасит побуквенный шквал, отмена
 * освобождает соединение, но решает не она: устаревший ответ отбрасывается по
 * номеру талона. Отмена не мгновенна, и ответ на отменённый запрос вполне может
 * дойти — тогда без талона он перетёр бы более свежий.
 */
function search({ immediate = false } = {}) {
  writeFilters()
  clearTimeout(debounce)
  debounce = setTimeout(run, immediate ? 0 : 150)
}

async function run() {
  inFlight?.abort()
  const controller = new AbortController()
  inFlight = controller
  const ticket = gate.next()

  const params = new URLSearchParams({ limit: '24' })
  if (filters.q) params.set('q', filters.q)
  if (filters.type) params.set('type', filters.type)
  if (filters.min) params.set('min', filters.min)
  if (filters.max) params.set('max', filters.max)
  if (filters.sort) params.set('sort', filters.sort)

  try {
    const snapshot = await request(`/api/catalog?${params}`, { signal: controller.signal })
    if (!gate.accept(ticket)) return
    applySnapshot(snapshot)
    renderCards(snapshot.offers)
    showFound(snapshot.total)
  } catch (error) {
    if (error.name === 'AbortError') return
    toast('Не удалось загрузить каталог', 'error')
  }
}

function showFound(total) {
  const active = filters.q || filters.type || filters.min || filters.max
  document.getElementById('found').textContent = active ? `Найдено: ${total}` : ''
  document.getElementById('cards-title').textContent = filters.q
    ? `Результаты по запросу «${filters.q}»`
    : 'Популярные товары'
}

function initFilters() {
  const input = document.getElementById('search-input')
  const min = document.getElementById('f-min')
  const max = document.getElementById('f-max')
  const sort = document.getElementById('f-sort')

  input.value = filters.q
  min.value = filters.min ?? ''
  max.value = filters.max ?? ''
  sort.value = filters.sort ?? ''

  input.addEventListener('input', () => {
    filters.q = input.value.trim()
    search()
  })
  for (const [node, key] of [[min, 'min'], [max, 'max']]) {
    node.addEventListener('input', () => {
      filters[key] = node.value.trim() || null
      search()
    })
  }
  sort.addEventListener('change', () => {
    filters.sort = sort.value || null
    search({ immediate: true })
  })
  document.getElementById('f-reset').addEventListener('click', () => {
    Object.assign(filters, { q: '', type: null, min: null, max: null, sort: null })
    input.value = ''
    min.value = ''
    max.value = ''
    sort.value = ''
    for (const item of document.getElementById('tabs').children) {
      item.setAttribute('aria-selected', String(item === document.getElementById('tabs').firstElementChild))
    }
    search({ immediate: true })
  })
}

function renderServices() {
  const host = document.getElementById('services')
  host.innerHTML = [
    ...SERVICES.map(
      (service) => `
      <button class="service" type="button">
        <img src="${service.image}" alt="" loading="lazy" />
        <span>${service.name}</span>
      </button>`,
    ),
    `<button class="service" type="button">
       <span class="service__more"><img src="assets/ui/robot.png" alt="" width="26" height="26" /></span>
       <span>ещё 841</span>
     </button>`,
  ].join('')
}

function renderTabs() {
  const host = document.getElementById('tabs')
  host.innerHTML = TABS.map(
    (tab, i) => `<button class="tab" role="tab" aria-selected="${i === 0}">${tab.label}</button>`,
  ).join('')

  host.addEventListener('click', (event) => {
    const tab = event.target.closest('.tab')
    if (!tab) return
    for (const item of host.children) item.setAttribute('aria-selected', String(item === tab))
    filters.type = TABS[[...host.children].indexOf(tab)].type
    search({ immediate: true })
  })
}

/** Вкладка, соответствующая типу из адреса: прямая ссылка открывает её выбранной. */
function selectTab() {
  const host = document.getElementById('tabs')
  const index = Math.max(TABS.findIndex((tab) => tab.type === filters.type), 0)
  for (const [i, item] of [...host.children].entries()) {
    item.setAttribute('aria-selected', String(i === index))
  }
}

/**
 * Карточки собираются один раз, дальше только правятся. Пересборка списка
 * целиком — это мигание, которого ТЗ прямо просит избежать.
 */
function renderCards(offers) {
  const host = document.getElementById('cards')
  const next = new Set(offers.map((offer) => offer.offer_id))

  // Заглушка «ничего не нашлось» — текстовый узел; убираем, иначе карточки
  // лягут после неё.
  for (const node of [...host.childNodes]) if (node.nodeType === Node.TEXT_NODE) node.remove()

  // Ушедшие из выдачи убираем, оставшиеся переиспользуем. Карточка привязана к
  // предложению по id, поэтому чужих данных в ней оказаться не может.
  for (const [id, node] of cards) {
    if (next.has(id)) continue
    node.remove()
    cards.delete(id)
  }

  // Переставляем только то, что реально не на своём месте. Безусловный append
  // тоже переиспользует узлы, но трогает DOM на каждой букве, хотя выдача могла
  // не измениться вовсе.
  let previous = null
  for (const offer of offers) {
    let card = cards.get(offer.offer_id)
    if (!card) {
      card = createCard(offer)
      cards.set(offer.offer_id, card)
    }
    const expected = previous ? previous.nextSibling : host.firstChild
    if (card !== expected) host.insertBefore(card, expected)
    previous = card
    paint(offer.offer_id)
  }

  host.classList.toggle('cards--empty', offers.length === 0)
  if (!offers.length) host.textContent = 'Ничего не нашлось. Попробуйте изменить запрос или фильтры.'
}

function createCard(offer) {
  const link = `product.html?sku=${encodeURIComponent(offer.sku)}`
  const card = document.createElement('article')
  card.className = 'card'
  card.innerHTML = `
    <a class="card__cover" href="${link}"><img src="${offer.image}" alt="" loading="lazy" /></a>
    <a class="card__name" href="${link}">${offer.name}</a>
    <div class="card__seller"></div>
    <div class="card__price"><b></b><s></s></div>
    <div class="card__stock"></div>
    <a class="btn-primary card__buy" href="${link}">Купить</a>`
  return card
}

function repaint(changed) {
  changed.forEach(paint)
}

function paint(offerId) {
  const card = cards.get(offerId)
  const offer = get(offerId)
  if (!card || !offer) return

  const sold = offer.available === 0
  card.querySelector('.card__seller').textContent =
    offer.sellers > 1 ? `${offer.seller_name} и ещё ${offer.sellers - 1}` : offer.seller_name
  card.querySelector('.card__price b').textContent = money(offer.price_rub)
  card.querySelector('.card__price s').textContent = money(Math.round((offer.price_rub * 1.6) / 10) * 10)
  card.querySelector('.card__stock').textContent = sold ? 'Нет в наличии' : `В наличии: ${offer.available}`
  card.querySelector('.card__stock').dataset.sold = String(sold)

  const buy = card.querySelector('.card__buy')
  buy.textContent = sold ? 'Раскупили' : 'Купить'
  buy.classList.toggle('is-disabled', sold)
  // Ссылку у распроданного товара не убираем: на карточке товара видно
  // остальных продавцов, и туда попасть по-прежнему можно.
}


/** Путь первого этапа: покупка по товару, продавца выбирает сервер. */
async function buyBySku(button) {
  if (button.dataset.busy === 'true') return
  button.dataset.busy = 'true'
  button.disabled = true
  const label = button.textContent
  button.textContent = 'Создаём заказ…'
  button.dataset.idempotencyKey ??= uuid()

  try {
    const order = await createOrder(
      { sku: button.dataset.sku },
      { idempotencyKey: button.dataset.idempotencyKey, promoCode: activePromo },
    )
    location.href = `order.html?id=${encodeURIComponent(order.id)}`
  } catch (error) {
    button.dataset.idempotencyKey = uuid() // неудачная попытка — новый ключ
    toast(errorText(error), 'error')
    button.disabled = false
    button.dataset.busy = 'false'
    button.textContent = label
  }
}

function initPromo() {
  const toggle = document.getElementById('promo-toggle')
  const field = document.getElementById('promo-field')
  const input = document.getElementById('promo-input')
  const apply = document.getElementById('promo-apply')

  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true'
    toggle.setAttribute('aria-expanded', String(open))
    field.hidden = !open
    if (open) input.focus()
  })

  const check = async () => {
    const code = input.value.trim()
    if (!code) {
      activePromo = null
      return
    }
    try {
      // Предпросмотр считает сервер: клиент не знает ни цен, ни правил скидок.
      const quote = await quotePromo(code, 'STEAM-TOPUP-500')
      activePromo = quote.code
      toast(`Промокод ${quote.code} применится к следующей покупке: −${money(quote.discount)}`)
    } catch (error) {
      activePromo = null
      toast(errorText(error), 'error')
    }
  }

  apply.addEventListener('click', check)
  input.addEventListener('keydown', (event) => event.key === 'Enter' && check())
}
