import { adminOffers, checker, createOrder, drainTo, ensureStock, freeUnits, reset, stats, uid } from './lib.mjs'

export const name = 'Гонка за последней единицей: покупатели берут один товар наперегонки'

const SKU = 'KEY-GTA5'

async function race(offerId, attempts) {
  const responses = await Promise.all(
    Array.from({ length: attempts }, () => createOrder(null, { key: uid('race'), offerId })),
  )
  return {
    won: responses.filter((r) => r.status === 201),
    soldOut: responses.filter((r) => r.status === 409 && r.body.error === 'sold_out'),
    broken: responses.filter((r) => r.status >= 500),
  }
}

export async function run() {
  const c = checker()
  await reset()
  await ensureStock(SKU, 12)

  const [offer] = await adminOffers(SKU)

  // ── Часть 1. Заказов больше, чем товара: лишние должны получить отказ.
  const stock = await freeUnits(SKU, offer.id)
  const wide = await race(offer.id, stock + 8)

  c.eq('заказов ровно по числу единиц, не больше', wide.won.length, stock)
  c.eq('лишние получили отказ «раскупили»', wide.soldOut.length, 8)
  c.eq('ни одного сбоя сервера', wide.broken.length, 0)
  c.eq('единиц удержано ровно по числу заказов', (await stats()).stock.held, stock)
  c.eq('свободных не осталось', await freeUnits(SKU, offer.id), 0)

  // ── Часть 2. Последняя единица: двенадцать покупателей, победитель один.
  await reset()
  await ensureStock(SKU, 12)
  const left = await drainTo(SKU, offer.id, 1)
  c.eq('перед гонкой осталась ровно одна единица', left, 1)

  const last = await race(offer.id, 12)
  c.eq('последнюю единицу получил ровно один', last.won.length, 1)
  c.eq('остальные одиннадцать получили понятный отказ', last.soldOut.length, 11)
  c.eq('и снова без сбоев сервера', last.broken.length, 0)

  // Пункт 2.2 ТЗ: проигравшему предлагают другого продавца, а не пустоту.
  const alternatives = last.soldOut[0]?.body.alternatives ?? []
  c.ok('проигравшему предложен другой продавец', alternatives.length > 0,
    alternatives.map((a) => `${a.seller_name} ${a.price_rub}₽`).join(', '))
  c.ok('у предложенного продавца товар действительно есть',
    alternatives.every((a) => a.available > 0), JSON.stringify(alternatives.map((a) => a.available)))
  c.ok('это другое предложение, а не то же самое',
    alternatives.every((a) => a.id !== offer.id), 'id')

  // Пункт 2.3 ТЗ: оплаченных заказов без товара не появилось.
  const s = await stats()
  const paidWithoutStock = (s.orders_by_status ?? []).find((row) => row.status === 'out_of_stock')
  c.eq('оплаченных заказов без товара нет', paidWithoutStock?.count ?? 0, 0)
  return c.checks
}
