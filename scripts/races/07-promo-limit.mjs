import { checker, createOrder, ensureStock, reset, uid } from './lib.mjs'

export const name = 'Промокод под гонкой: лимит использований не пробивается'

async function race(code, attempts) {
  const responses = await Promise.all(
    Array.from({ length: attempts }, () => createOrder('KEY-GTA5', { key: uid('promo'), promo: code })),
  )
  const ok = responses.filter((r) => r.status === 201 && r.body.promo_code === code)
  const rejected = responses.filter((r) => r.body.error === 'promo_limit_reached')
  return { ok, rejected, responses }
}

export async function run() {
  const c = checker()
  await reset()
  // Сценарий про лимит промокода, а не про склад: раскупленный товар отклонял бы
  // запросы раньше, чем до промокода дойдёт дело.
  await ensureStock('KEY-GTA5', 60)

  const once = await race('ONCEONLY', 25)
  const first = once.ok[0]?.body
  c.eq('ONCEONLY (лимит 1): применён ровно 1 раз', once.ok.length, 1)
  c.eq('остальные отклонены с понятной ошибкой', once.rejected.length, 24)
  // Сумма заказа — цена продавца, а не номинал из каталога, поэтому ожидание
  // считается от неё. Проверяется именно то, что скидку посчитал сервер.
  c.eq('скидку посчитал сервер (50% от суммы заказа)',
    first?.discount_rub, Math.floor((first?.amount_rub ?? 0) * 0.5))
  c.eq('итог к оплате', first?.total_rub, (first?.amount_rub ?? 0) - (first?.discount_rub ?? 0))

  const three = await race('LIMIT3', 30)
  c.eq('LIMIT3 (лимит 3): применён ровно 3 раза', three.ok.length, 3)
  c.eq('остальные отклонены', three.rejected.length, 27)

  // Клиенту не верим: цену и скидку он прислать не может — их просто не читают.
  const forged = (await createOrder('KEY-GTA5', { key: uid('forge'), promo: 'WELCOME10' })).body
  c.eq('скидка 10% посчитана сервером', forged.discount_rub, Math.floor(forged.amount_rub * 0.1))
  c.eq('итог = цена − скидка', forged.total_rub, forged.amount_rub - forged.discount_rub)
  return c.checks
}
