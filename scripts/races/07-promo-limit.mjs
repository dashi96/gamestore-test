import { checker, createOrder, reset, uid } from './lib.mjs'

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

  const once = await race('ONCEONLY', 25)
  c.eq('ONCEONLY (лимит 1): применён ровно 1 раз', once.ok.length, 1)
  c.eq('остальные отклонены с понятной ошибкой', once.rejected.length, 24)
  c.eq('скидку посчитал сервер (50% от 1990)', once.ok[0]?.body.discount_rub, 995)
  c.eq('итог к оплате', once.ok[0]?.body.total_rub, 995)

  const three = await race('LIMIT3', 30)
  c.eq('LIMIT3 (лимит 3): применён ровно 3 раза', three.ok.length, 3)
  c.eq('остальные отклонены', three.rejected.length, 27)

  // Клиенту не верим: цену и скидку он прислать не может — их просто не читают.
  const forged = await createOrder('KEY-GTA5', { key: uid('forge'), promo: 'WELCOME10' })
  c.eq('скидка 10% посчитана сервером', forged.body.discount_rub, 199)
  c.eq('итог = цена − скидка', forged.body.total_rub, forged.body.amount_rub - 199)
  return c.checks
}
