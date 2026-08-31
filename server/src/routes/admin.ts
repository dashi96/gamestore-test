import type { FastifyInstance, FastifyRequest } from 'fastify'
import { config, type ProviderId } from '../lib/config.ts'
import { pool } from '../lib/db.ts'
import { ApiError, badRequest } from '../lib/errors.ts'
import { requestRedelivery } from '../core/delivery.ts'
import { adminFetch } from '../core/providers.ts'
import { getOrderView } from '../core/orders.ts'

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

  app.get('/admin/stats', async () => {
    const { rows: byStatus } = await pool.query(
      'select status, count(*)::int as count from orders group by status order by status',
    )
    const [{ rows: totals }, { rows: events }] = await Promise.all([
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
    return { orders_by_status: byStatus, ...totals[0], events: events[0] }
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

  /** Сброс состояния между прогонами скриптов гонок. */
  app.post('/admin/reset', async () => {
    await pool.query('truncate promo_uses, deliveries, delivery_jobs, payment_events, orders cascade')
    await pool.query('update promocodes set used_count = 0')
    const [a, b] = await Promise.all([
      adminFetch('a', '/admin/reset', { method: 'POST' }),
      adminFetch('b', '/admin/reset', { method: 'POST' }),
    ])
    return { ok: true, providers: { a, b } }
  })
}
