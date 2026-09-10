import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { config } from './lib/config.ts'
import { pool, waitForDb } from './lib/db.ts'
import { ApiError } from './lib/errors.ts'
import * as stream from './core/stream.ts'
import { adminRoutes } from './routes/admin.ts'
import { cartRoutes } from './routes/cart.ts'
import { shopRoutes } from './routes/shop.ts'
import { streamRoutes } from './routes/stream.ts'
import { webhookRoutes } from './routes/webhook.ts'

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } })

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ApiError) {
    return reply
      .code(error.statusCode)
      .send({ error: error.code, message: error.message, ...error.details })
  }
  app.log.error(error)
  return reply.code(500).send({ error: 'internal_error' })
})

/**
 * Живость слушателя выведена наружу намеренно: без неё оборвавшийся `LISTEN`
 * выглядит как исправный сервис с замершими у всех ценами. 503 здесь честнее
 * 200 — снаружи видно, что витрина больше не живая.
 */
app.get('/health', async (_request, reply) => {
  const alive = stream.listenerAlive()
  reply.code(alive ? 200 : 503)
  return {
    ok: alive,
    listener: alive ? 'alive' : 'down',
    subscribers: stream.subscriberCount(),
    seq: stream.deliveredSeq(),
  }
})

await app.register(websocket)
await app.register(cartRoutes)
await app.register(shopRoutes)
await app.register(streamRoutes)
await app.register(webhookRoutes)
await app.register(adminRoutes)

await waitForDb()
await stream.start()
await app.listen({ port: config.port, host: '0.0.0.0' })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await stream.stop()
    await app.close()
    await pool.end()
    process.exit(0)
  })
}
