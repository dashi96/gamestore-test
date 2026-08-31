import { ApiError, createOrder, getProducts, money, quotePromo, uuid } from './api.js'
import { initCarousel } from './carousel.js'
import { initCatalog } from './catalog.js'
import { initCurrency } from './currency.js'
import { toast } from './toast.js'

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
    title: 'Ключи со скидкой до 60%',
    text: 'Каждый ключ выдаётся ровно один раз: он закрепляется за заказом в момент выдачи.',
    background: 'linear-gradient(120deg, #171018 0%, #4a1e3d 100%)',
  },
  {
    title: 'Подписки без привязки карты',
    text: 'Discord Nitro, YouTube Premium, Spotify — оплата в рублях.',
    background: 'linear-gradient(120deg, #101815 0%, #1f4536 100%)',
  },
  {
    title: 'Гифт-карты PSN и Xbox',
    text: 'Номиналы на любой регион, код приходит на страницу заказа.',
    background: 'linear-gradient(120deg, #14121b 0%, #3a2a63 100%)',
  },
]

const TABS = ['Донат', 'Подписки', 'Предметы', 'Аккаунты', 'Ключи', 'Игровая валюта', 'Другое']

/** Промокод живёт в памяти страницы: на сервер уходит только его код. */
let activePromo = null

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

  document.getElementById('topup-buy').addEventListener('click', (event) => buy(event.currentTarget))

  try {
    const { products } = await getProducts()
    renderCards(products.filter((p) => p.type === 'key' || p.type === 'giftcard').slice(0, 5))
  } catch {
    toast('Не удалось загрузить каталог', 'error')
  }
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
    (tab, i) =>
      `<button class="tab" role="tab" aria-selected="${i === 0}">${tab}</button>`,
  ).join('')

  host.addEventListener('click', (event) => {
    const tab = event.target.closest('.tab')
    if (!tab) return
    for (const item of host.children) item.setAttribute('aria-selected', String(item === tab))
  })
}

function renderCards(products) {
  const host = document.getElementById('cards')
  host.innerHTML = products
    .map(
      (product) => `
      <article class="card">
        <div class="card__cover"><img src="${product.image}" alt="" loading="lazy" /></div>
        <div class="card__name">${product.name}</div>
        <div class="card__price">
          <b>${money(product.price_rub)}</b>
          <s>${money(Math.round((product.price_rub * 1.6) / 10) * 10)}</s>
        </div>
        <button class="btn-primary" data-sku="${product.sku}">Купить</button>
      </article>`,
    )
    .join('')

  host.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-sku]')
    if (button) buy(button)
  })
}

/**
 * Покупка. Ключ идемпотентности выдаётся один на кнопку и не меняется до
 * ответа сервера: пока запрос в полёте, кнопка заблокирована, а если клик
 * всё-таки прошёл дважды — сервер вернёт тот же самый заказ.
 */
async function buy(button) {
  if (button.dataset.busy === 'true') return
  button.dataset.busy = 'true'
  button.disabled = true
  const label = button.textContent
  button.textContent = 'Создаём заказ…'

  button.dataset.idempotencyKey ??= uuid()

  try {
    const order = await createOrder(button.dataset.sku, {
      idempotencyKey: button.dataset.idempotencyKey,
      promoCode: activePromo,
    })
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
      toast(`Промокод ${quote.code} применится к следующей покупке: −${money(quote.discount)} на пополнение 500 ₽`)
    } catch (error) {
      activePromo = null
      toast(errorText(error), 'error')
    }
  }

  apply.addEventListener('click', check)
  input.addEventListener('keydown', (event) => event.key === 'Enter' && check())
}

function errorText(error) {
  if (!(error instanceof ApiError)) return 'Что-то пошло не так'
  return (
    {
      promo_not_found: 'Промокод не найден',
      promo_limit_reached: 'Лимит промокода исчерпан',
      unknown_sku: 'Товар недоступен',
    }[error.code] ?? error.message
  )
}
