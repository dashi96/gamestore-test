import { checker, createOrder, reset, uid } from './lib.mjs'

export const name = 'Двойной клик «Купить»: 20 параллельных созданий заказа с одним Idempotency-Key'

export async function run() {
  const c = checker()
  await reset()

  const key = uid('click')
  const responses = await Promise.all(
    Array.from({ length: 20 }, () => createOrder('KEY-GTA5', { key })),
  )

  const ids = new Set(responses.map((r) => r.body.id))
  const created = responses.filter((r) => r.status === 201).length

  c.eq('создан ровно один заказ', ids.size, 1)
  c.eq('ровно один ответ 201 Created', created, 1)
  c.ok('остальные 19 вернули тот же заказ', responses.every((r) => r.body.id === [...ids][0]))
  return c.checks
}
