import Fastify from 'fastify'
import { config } from './lib/config.ts'
import { pool, waitForDb } from './lib/db.ts'
import { ApiError } from './lib/errors.ts'
import { adminRoutes } from './routes/admin.ts'
import { shopRoutes } from './routes/shop.ts'
import { webhookRoutes } from './routes/webhook.ts'

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } })

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ApiError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message })
  }
  app.log.error(error)
  return reply.code(500).send({ error: 'internal_error' })
})

app.get('/health', async () => ({ ok: true }))

await app.register(shopRoutes)
await app.register(webhookRoutes)
await app.register(adminRoutes)

await waitForDb()
await app.listen({ port: config.port, host: '0.0.0.0' })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close()
    await pool.end()
    process.exit(0)
  })
}
