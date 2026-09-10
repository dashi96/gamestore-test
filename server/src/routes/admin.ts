import type { FastifyInstance, FastifyRequest } from 'fastify'
import { config, type ProviderId } from '../lib/config.ts'
import { pool, tx } from '../lib/db.ts'
import { ApiError, badRequest } from '../lib/errors.ts'
import { requestRedelivery } from '../core/delivery.ts'
import { adminFetch } from '../core/providers.ts'
import { getOrderView } from '../core/orders.ts'
import * as events from '../core/events.ts'
import { FREE_UNIT, getOffer } from '../core/stock.ts'

/** Авторизация «по-простому»: один Bearer-токен, как разрешает ТЗ. */
function requireToken(request: FastifyRequest) {
  const header = request.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (token !== config.adminToken) throw new ApiError(401, 'unauthorized')
}

const asProvider = (value: string): ProviderId => {
  if (value !== 'a' && value !== 'b') throw badRequest('unknown_provider')
  return value
}

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (request) => requireToken(request))

  /** Заказы «оплачен, но не выдан» — главный экран админки. */
  app.get('/admin/orders', async (request) => {
    const { scope = 'stuck' } = request.query as { scope?: 'stuck' | 'all' }
    const where =
      scope === 'stuck'
        ? `o.status in ('paid','delivering','out_of_stock','delivery_failed') and d.order_id is null`
        : 'true'
    const { rows } = await pool.query(
      `select o.id, o.sku, o.status, o.status_reason, o.total_rub, o.promo_code,
              o.created_at, o.updated_at,
              d.code, d.provider,
              j.attempts, j.provider as job_provider, j.next_run_at, j.last_error
         from orders o
         left join deliveries d on d.order_id = o.id
         left join delivery_jobs j on j.order_id = o.id
        where ${where}
        order by o.created_at desc
        limit 100`,
    )
    return { orders: rows }
  })

  app.get('/admin/orders/:id', async (request) => {
    const { id } = request.params as { id: string }
    const view = await getOrderView(id)
    const { rows: events } = await pool.query(
      'select event_id, status, amount_rub, received_at, processed_at, note from payment_events where order_id = $1 order by received_at',
      [id],
    )
    const { rows: jobs } = await pool.query('select * from delivery_jobs where order_id = $1', [id])
    return { order: view, events, job: jobs[0] ?? null }
  })

  /** Безопасная ручная перевыдача: повтор ничего не задваивает. */
  app.post('/admin/orders/:id/redeliver', async (request) => {
    const { id } = request.params as { id: string }
    return requestRedelivery(id)
  })

  /**
   * Цена предложения. Этой ручкой показывается пункт 1.1 ТЗ: изменение видно во
   * всех открытых вкладках без перезагрузки. Событие пишется после обновления
   * строки и в той же транзакции — иначе номера событий разойдутся с порядком
   * фиксации.
   */
  app.post('/admin/offers/:id/price', async (request) => {
    const id = Number((request.params as { id: string }).id)
    const { price_rub } = (request.body ?? {}) as { price_rub?: number }
    if (!Number.isInteger(price_rub) || price_rub! < 0) throw badRequest('price_rub_required')

    return tx(async (client) => {
      const { rowCount } = await client.query(
        'update offers set price_rub = $2 where id = $1',
        [id, price_rub],
      )
      if (!rowCount) throw badRequest('unknown_offer')
      const seq = await events.emit(client, id)
      return { ok: true, offer_id: id, price_rub, seq }
    })
  })

  /**
   * Предложения товара с внутренними подробностями: какой продавец на каком
   * поставщике и сколько единиц свободно. На витрине этого нет — покупателю
   * незачем знать, кто у продавца поставщик.
   */
  app.get('/admin/offers', async (request) => {
    const { sku } = request.query as { sku?: string }
    if (!sku) throw badRequest('sku_required')
    const { rows } = await pool.query(
      `select o.id, o.sku, o.seller_id, s.name as seller_name, s.provider_id, o.price_rub,
              (select count(*)::int from stock_units u where u.offer_id = o.id and ${FREE_UNIT}) as free,
              (select count(*)::int from stock_units u where u.offer_id = o.id) as units
         from offers o join sellers s on s.id = o.seller_id
        where o.sku = $1 order by o.price_rub, o.id`,
      [sku],
    )
    return { offers: rows }
  })

  /**
   * Пополнение склада предложения: восстановимые заказы после этого доезжают сами.
   * Долитые единицы помечены префиксом `top_` и убираются сбросом, иначе каталог
   * распухал бы от прогона к прогону.
   */
  app.post('/admin/offers/:id/stock', async (request) => {
    const id = Number((request.params as { id: string }).id)
    const { count = 1 } = (request.body ?? {}) as { count?: number }
    if (!Number.isInteger(count) || count < 1 || count > 1000) throw badRequest('bad_count')

    return tx(async (client) => {
      const offer = await getOffer(client, id)
      if (!offer) throw badRequest('unknown_offer')
      await client.query(
        // Приведения обязательны: без них $1 стоит и на месте bigint, и внутри
        // склейки строк, а один параметр в двух типах Postgres вывести не может.
        `insert into stock_units (offer_id, code_ref)
         select $1::bigint, 'top_' || $1::text || '_' || gen_random_uuid()
           from generate_series(1, $2::int)`,
        [id, count],
      )
      const seq = await events.emit(client, id)
      return { ok: true, offer_id: id, added: count, seq }
    })
  })

  /**
   * Довести каждое предложение товара до заданного числа свободных единиц.
   * Нужно сценариям, которые проверяют не склад, а что-то другое: лимит
   * промокода или устойчивость выдачи. Склад в них не должен быть узким местом.
   */
  app.post('/admin/stock', async (request) => {
    const { sku, per_offer = 10 } = (request.body ?? {}) as { sku?: string; per_offer?: number }
    if (!sku) throw badRequest('sku_required')
    if (!Number.isInteger(per_offer) || per_offer < 1 || per_offer > 500) throw badRequest('bad_per_offer')

    return tx(async (client) => {
      const { rows } = await client.query<{ id: number }>(
        `with target as (
           select o.id,
                  (select count(*)::int from stock_units u where u.offer_id = o.id and ${FREE_UNIT}) as free
             from offers o where o.sku = $1
         ),
         added as (
           insert into stock_units (offer_id, code_ref)
           select t.id, 'top_' || t.id || '_' || gen_random_uuid()
             from target t, generate_series(1, greatest(0, $2 - t.free))
           returning offer_id
         )
         select distinct offer_id as id from added order by id`,
        [sku, per_offer],
      )
      for (const row of rows) await events.emit(client, row.id)
      return { ok: true, sku, per_offer, topped_up_offers: rows.length }
    })
  })

  /**
   * Приблизить срок брони. Нужна и для сценариев, и для показа на звонке: ждать
   * семь минут незачем. Саму бронь эта ручка НЕ снимает — она двигает только
   * дедлайн, а снимает по-прежнему развёртка в воркере. Проверяется настоящий
   * путь, а не его обход.
   */
  app.post('/admin/orders/:id/expire', async (request) => {
    const { id } = request.params as { id: string }
    // hard: true двигает и потолок. Без него заказ в awaiting_payment остаётся
    // защищённым — именно это различие и надо уметь проверить.
    const { hard = false } = (request.body ?? {}) as { hard?: boolean }
    const { rowCount } = await pool.query(
      `update reservations
          set expires_at = now(),
              hard_expires_at = case when $2 then now() else hard_expires_at end
        where order_id = $1 and released_at is null`,
      [id, hard],
    )
    return { ok: Boolean(rowCount), order_id: id, hard }
  })

  app.get('/admin/stats', async () => {
    const { rows: byStatus } = await pool.query(
      'select status, count(*)::int as count from orders group by status order by status',
    )
    const [{ rows: totals }, { rows: paymentEvents }] = await Promise.all([
      pool.query(
        `select (select count(*)::int from deliveries) as deliveries,
                (select count(distinct code)::int from deliveries) as distinct_codes,
                (select count(*)::int from delivery_jobs) as pending_jobs`,
      ),
      pool.query(
        `select count(*)::int as total,
                count(*) filter (where processed_at is null)::int as parked
           from payment_events`,
      ),
    ])
    const { rows: stock } = await pool.query(
      `select (select count(*)::int from stock_units) as units,
              (select count(*)::int from stock_units where sold_order_id is not null) as sold,
              (select count(*)::int from reservations where released_at is null) as held,
              (select count(*)::int from events) as offer_events`,
    )
    return {
      orders_by_status: byStatus,
      ...totals[0],
      events: paymentEvents[0],
      stock: stock[0],
    }
  })

  app.get('/admin/providers', async () => {
    const [a, b] = await Promise.all([adminFetch('a', '/admin/state'), adminFetch('b', '/admin/state')])
    return { a, b }
  })

  /** Ручки для сценариев этапа 3: душим поставщика или пополняем остаток. */
  app.post('/admin/providers/:id/config', async (request) => {
    const provider = asProvider((request.params as { id: string }).id)
    return adminFetch(provider, '/admin/config', {
      method: 'POST',
      body: JSON.stringify(request.body ?? {}),
    })
  })

  app.post('/admin/providers/:id/stock', async (request) => {
    const provider = asProvider((request.params as { id: string }).id)
    return adminFetch(provider, '/admin/stock', {
      method: 'POST',
      body: JSON.stringify(request.body ?? {}),
    })
  })

  /**
   * Сброс состояния между прогонами скриптов гонок.
   *
   * Намеренно DELETE, а не TRUNCATE ... CASCADE: на `orders` теперь ссылается
   * `stock_units.sold_order_id`, и каскад увёл бы за собой весь каталог. Каскад
   * смотрит на связи в схеме, а не на данные, так что обнуление ссылок его бы
   * не спасло.
   */
  app.post('/admin/reset', async () => {
    // Очистка и сброс счётчиков — одной транзакцией: между ними не должно быть
    // момента, когда заказов уже нет, а промокоды числятся израсходованными.
    await tx(async (client) => {
      // И держателя, и продажу: обе ссылки идут на orders, а заказы сейчас удалим.
      await client.query('update stock_units set sold_order_id = null, held_by_order = null')
      for (const table of [
        'reservations',
        'promo_uses',
        'deliveries',
        'delivery_jobs',
        'payment_events',
        'cart_items',
        'events',
        'orders',
      ]) {
        await client.query(`delete from ${table}`)
      }
      // Долитые сценариями единицы убираются последними: на них ссылаются брони,
      // и удалять их раньше внешний ключ не даёт.
      await client.query("delete from stock_units where code_ref like 'top\\_%'")
      await client.query('update promocodes set used_count = 0')
    })
    const [a, b] = await Promise.all([
      adminFetch('a', '/admin/reset', { method: 'POST' }),
      adminFetch('b', '/admin/reset', { method: 'POST' }),
    ])
    return { ok: true, providers: { a, b } }
  })
}
