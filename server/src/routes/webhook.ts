import type { FastifyInstance } from 'fastify'
import { handleWebhook, parseWebhook } from '../core/payments.ts'

export async function webhookRoutes(app: FastifyInstance) {
  /**
   * Контракт платёжной системы. Отвечаем быстро: приняли — 200, дальше выдачей
   * занимается воркер. 5xx означал бы «повторите доставку», и его мы отдаём
   * только при настоящем сбое БД.
   */
  app.post('/webhook/payment', async (request, reply) => {
    const body = parseWebhook(request.body)
    const result = await handleWebhook(body)
    reply.code(200)
    return { received: true, result }
  })
}
