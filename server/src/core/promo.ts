import type { Client } from '../lib/db.ts'
import { pool } from '../lib/db.ts'
import { conflict, notFound } from '../lib/errors.ts'

export type Promocode = {
  code: string
  type: 'percent' | 'amount'
  value: number
  max_uses: number
  used_count: number
}

/**
 * Скидку считает только сервер, из клиента приходит одна строка — код.
 * Ни цена, ни размер скидки с фронта не принимаются вообще.
 */
export function discountFor(promo: Pick<Promocode, 'type' | 'value'>, priceRub: number): number {
  const raw = promo.type === 'percent' ? Math.floor((priceRub * promo.value) / 100) : promo.value
  return Math.max(0, Math.min(raw, priceRub))
}

/** Предпросмотр для витрины: ничего не расходует. */
export async function quote(code: string, priceRub: number) {
  const { rows } = await pool.query<Promocode>('select * from promocodes where code = $1', [
    code.trim().toUpperCase(),
  ])
  const promo = rows[0]
  if (!promo) throw notFound('promo_not_found', 'Промокод не найден')
  if (promo.used_count >= promo.max_uses) throw conflict('promo_limit_reached', 'Лимит промокода исчерпан')

  const discount = discountFor(promo, priceRub)
  return { code: promo.code, type: promo.type, value: promo.value, discount, total: priceRub - discount }
}

/**
 * Расход промокода под гонкой. Один UPDATE с условием used_count < max_uses:
 * строку блокирует сам Postgres, «прочитали → проверили → записали» здесь нет,
 * поэтому N параллельных запросов дают ровно max_uses успехов.
 */
export async function reserve(client: Client, code: string, orderId: string, priceRub: number) {
  const normalized = code.trim().toUpperCase()
  const { rows } = await client.query<Promocode>(
    `update promocodes set used_count = used_count + 1
      where code = $1 and used_count < max_uses
      returning *`,
    [normalized],
  )
  const promo = rows[0]
  if (!promo) {
    const exists = await client.query('select 1 from promocodes where code = $1', [normalized])
    throw exists.rowCount
      ? conflict('promo_limit_reached', 'Лимит промокода исчерпан')
      : notFound('promo_not_found', 'Промокод не найден')
  }

  await client.query('insert into promo_uses (order_id, code) values ($1, $2)', [orderId, promo.code])
  return { code: promo.code, discount: discountFor(promo, priceRub) }
}

/**
 * Возврат промокода, если оплата не прошла. Вызывается ровно один раз —
 * из перехода created → payment_failed, который сам защищён проверкой статуса.
 */
export async function release(client: Client, orderId: string) {
  const { rows } = await client.query<{ code: string }>(
    'delete from promo_uses where order_id = $1 returning code',
    [orderId],
  )
  const use = rows[0]
  if (!use) return
  await client.query(
    'update promocodes set used_count = used_count - 1 where code = $1 and used_count > 0',
    [use.code],
  )
}
