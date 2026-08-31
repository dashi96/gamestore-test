import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Fastify from 'fastify'

/**
 * Заглушка поставщика ключей по контракту из ТЗ.
 *
 * Главное в ней — не выдача кода, а честное воспроизведение ловушки таймаута:
 * при «зависании» поставщик СНАЧАЛА расходует ключ и запоминает его за
 * request_id, и только потом перестаёт отвечать. Клиент видит таймаут, хотя код
 * уже выдан. Повтор с тем же request_id обязан вернуть тот же самый код —
 * иначе на каждом таймауте терялся бы ключ, а заказ получал бы второй.
 */

const providerId = process.env.PROVIDER_ID ?? 'a'
const port = Number(process.env.PORT ?? 4000)
const adminToken = process.env.ADMIN_TOKEN ?? 'admin-token'
const maxHangMs = Number(process.env.MAX_HANG_MS ?? 60_000)

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '../../data')
const allKeys: string[] = JSON.parse(await readFile(join(dataDir, 'keys.json'), 'utf8'))

const [from, to] = (process.env.STOCK_SLICE ?? '0:50').split(':').map(Number)
const initialStock = allKeys.slice(from, to)

const state = {
  stock: [...initialStock],
  /** request_id → выданный код. Идемпотентность на стороне поставщика. */
  issued: new Map<string, string>(),
  config: {
    errorRate: Number(process.env.ERROR_RATE ?? 0.15),
    timeoutRate: Number(process.env.TIMEOUT_RATE ?? 0.1),
    latencyMs: Number(process.env.LATENCY_MS ?? 50),
  },
  stats: { requests: 0, replays: 0, errors: 0, timeouts: 0, issued: 0 },
}

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

app.post('/issue', async (request, reply) => {
  const body = (request.body ?? {}) as { request_id?: string; sku?: string; order_id?: string }
  if (!body.request_id) return reply.code(400).send({ status: 'error', reason: 'request_id_required' })
  state.stats.requests++

  await sleep(state.config.latencyMs)

  // Повтор запроса — всегда тот же код, без рулетки отказов. Это контракт.
  const known = state.issued.get(body.request_id)
  if (known) {
    state.stats.replays++
    return reply.send({ status: 'ok', request_id: body.request_id, code: known })
  }

  if (Math.random() < state.config.errorRate) {
    state.stats.errors++
    return reply.code(500).send({ status: 'error', reason: 'provider_error' })
  }

  const code = state.stock.shift()
  if (!code) {
    return reply.code(409).send({ status: 'error', reason: 'out_of_stock' })
  }

  // Ключ израсходован и закреплён за request_id — до решения о «зависании».
  state.issued.set(body.request_id, code)
  state.stats.issued++

  if (Math.random() < state.config.timeoutRate) {
    state.stats.timeouts++
    app.log.warn({ request_id: body.request_id, code }, 'выдал код и завис: ответ не дойдёт')
    await sleep(maxHangMs)
    return reply.code(504).send({ status: 'error', reason: 'timeout' })
  }

  return reply.send({ status: 'ok', request_id: body.request_id, code })
})

app.register(async (admin) => {
  admin.addHook('preHandler', async (request, reply) => {
    const header = request.headers.authorization ?? ''
    if (header !== `Bearer ${adminToken}`) return reply.code(401).send({ error: 'unauthorized' })
  })

  admin.get('/admin/state', async () => ({
    provider: providerId,
    stock: state.stock.length,
    issued: state.issued.size,
    config: state.config,
    stats: state.stats,
  }))

  admin.get('/admin/issued', async () => ({
    provider: providerId,
    issued: Object.fromEntries(state.issued),
  }))

  /** Настройка доли отказов и таймаутов на лету — для сценариев этапа 3. */
  admin.post('/admin/config', async (request) => {
    const body = (request.body ?? {}) as Partial<typeof state.config>
    for (const key of ['errorRate', 'timeoutRate', 'latencyMs'] as const) {
      if (typeof body[key] === 'number') state.config[key] = body[key]
    }
    return { provider: providerId, config: state.config }
  })

  /** Пополнение остатка: {count} добавит новые ключи, {keys} — конкретные. */
  admin.post('/admin/stock', async (request) => {
    const body = (request.body ?? {}) as { count?: number; keys?: string[]; drain?: boolean }
    if (body.drain) state.stock = []
    if (Array.isArray(body.keys)) state.stock.push(...body.keys)
    if (body.count) {
      for (let i = 0; i < body.count; i++) state.stock.push(generateKey())
    }
    return { provider: providerId, stock: state.stock.length }
  })

  admin.post('/admin/reset', async () => {
    state.stock = [...initialStock]
    state.issued.clear()
    state.config.errorRate = Number(process.env.ERROR_RATE ?? 0.15)
    state.config.timeoutRate = Number(process.env.TIMEOUT_RATE ?? 0.1)
    state.stats = { requests: 0, replays: 0, errors: 0, timeouts: 0, issued: 0 }
    return { provider: providerId, stock: state.stock.length }
  })
})

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const generateKey = () =>
  Array.from({ length: 3 }, () =>
    Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(''),
  ).join('-')

await app.listen({ port, host: '0.0.0.0' })
app.log.info(`поставщик ${providerId}: ${state.stock.length} ключей в остатке`)
