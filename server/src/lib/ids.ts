import { randomBytes, randomUUID } from 'node:crypto'

const short = (bytes = 6) => randomBytes(bytes).toString('hex')

export const newOrderId = () => `ord_${short()}`
export const newEventId = () => `evt_${short()}`
export const newIdempotencyKey = () => randomUUID()

/**
 * request_id детерминирован по (заказ, поставщик) и не меняется между попытками.
 * Это ключевое: после таймаута мы повторяем запрос с тем же request_id,
 * поставщик обязан вернуть тот же код, а не выдать новый.
 */
export const requestIdFor = (orderId: string, provider: string) => `req_${orderId}_${provider}`
