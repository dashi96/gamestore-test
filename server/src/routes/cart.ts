import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { addItem, getCart, removeItem } from '../core/cart.ts'
import { badRequest } from '../lib/errors.ts'

/**
 * Корзина привязана к httpOnly-cookie. Своего парсера cookie нет намеренно:
 * значение ровно одно и это UUID, поэтому строгая проверка формы надёжнее
 * общего разбора — подставить в неё что-то постороннее не выйдет.
 */

const COOKIE = 'cart_id'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_AGE_SEC = 60 * 60 * 24 * 30

function readCartId(request: FastifyRequest): string | null {
  const header = request.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name !== COOKIE) continue
    const value = rest.join('=')
    return UUID.test(value) ? value : null
  }
  return null
}

/** Корзина заводится только при первой записи: гостям и роботам id не выдаём. */
function ensureCartId(request: FastifyRequest, reply: FastifyReply): string {
  const existing = readCartId(request)
  if (existing) return existing
  const id = randomUUID()
  reply.header(
    'set-cookie',
    `${COOKIE}=${id}; Path=/; Max-Age=${MAX_AGE_SEC}; HttpOnly; SameSite=Lax`,
  )
  return id
}

const asOfferId = (value: unknown) => {
  const id = Number(value)
  if (!Number.isInteger(id) || id <= 0) throw badRequest('offer_id_required')
  return id
}

export async function cartRoutes(app: FastifyInstance) {
  app.get('/api/cart', async (request) => getCart(readCartId(request)))

  app.post('/api/cart', async (request, reply) => {
    const { offer_id } = (request.body ?? {}) as { offer_id?: number }
    const cartId = ensureCartId(request, reply)
    await addItem(cartId, asOfferId(offer_id))
    return getCart(cartId)
  })

  app.delete('/api/cart/:offerId', async (request) => {
    const cartId = readCartId(request)
    if (!cartId) return getCart(null)
    await removeItem(cartId, asOfferId((request.params as { offerId: string }).offerId))
    return getCart(cartId)
  })
}
