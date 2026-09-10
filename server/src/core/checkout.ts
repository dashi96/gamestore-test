import type { Client } from '../lib/db.ts'
import { pool, tx } from '../lib/db.ts'
import { badRequest, conflict } from '../lib/errors.ts'
import { newOrderId } from '../lib/ids.ts'
import * as events from './events.ts'
import { findByIdempotencyKey, insertOrder, setOffer, type Order } from './orders.ts'
import * as promo from './promo.ts'
import { claimBySku, claimFromOffer, type Claim, type Reservation } from './reservations.ts'
import { alternatives, getOffer } from './stock.ts'

/**
 * Оформление: заказ и бронь появляются одной транзакцией. Порознь их создавать
 * нельзя — падение между двумя шагами оставило бы заказ без товара, да ещё и
 * съеденным ключом идемпотентности.
 *
 * Порядок внутри транзакции: сначала заказ (на него ссылается бронь), затем
 * захват единицы, и только потом расход промокода — проигравший гонку не должен
 * тратить лимит промокода впустую. Сумма заказа проставляется по цене, с которой
 * единица реально захвачена.
 */

export type CreateInput = {
  offerId?: number
  /** Путь первого этапа: заказ по товару, без выбора продавца. */
  sku?: string
  /**
   * Цена, которую покупатель видел на экране. Подорожало — отказываем и
   * показываем новую цену ДО оплаты; подешевело — молча пропускаем, отказывать
   * из-за скидки незачем.
   */
  expectedPriceRub?: number | null
  promoCode?: string | null
  idempotencyKey: string
  /** Позволяет задать id заранее — нужно, чтобы воспроизвести «вебхук раньше заказа». */
  orderId?: string
}

export type CreateResult = {
  order: Order
  reservation: Reservation | null
  created: boolean
}

export async function createOrder(input: CreateInput): Promise<CreateResult> {
  const existing = await findByIdempotencyKey(input.idempotencyKey)
  if (existing) return { ...(await withReservation(existing)), created: false }

  const target = await resolveTarget(input)

  try {
    return await tx(async (client) => {
      const order = await insertOrder(client, {
        id: input.orderId ?? newOrderId(),
        sku: target.sku,
        idempotencyKey: input.idempotencyKey,
      })
      if (!order) throw new DuplicateRequest()

      const claim = target.offerId
        ? await claimFromOffer(client, target.offerId, order.id)
        : await claimBySku(client, target.sku, order.id)
      if (!claim) throw new SoldOut(target.sku, target.offerId ?? 0)

      // Проверяем ту цену, по которой единица захвачена, а не прочитанную раньше:
      // между чтением и захватом цена могла измениться.
      if (input.expectedPriceRub != null && claim.priceRub > input.expectedPriceRub) {
        throw new PriceChanged(claim, input.expectedPriceRub)
      }

      const priced = await setOffer(client, order.id, claim.offerId, claim.priceRub)
      const final = input.promoCode
        ? await applyPromo(client, priced, input.promoCode, claim.priceRub)
        : priced

      // Событие — последним: состояние строк к этому моменту окончательное.
      await events.emit(client, claim.offerId)
      return { order: final, reservation: claim.reservation, created: true }
    })
  } catch (err) {
    if (err instanceof DuplicateRequest) {
      const found = await findByIdempotencyKey(input.idempotencyKey)
      if (found) return { ...(await withReservation(found)), created: false }
      throw err
    }
    if (err instanceof PriceChanged) {
      throw conflict('price_changed', 'Цена изменилась, пока товар лежал в корзине', {
        offer_id: err.claim.offerId,
        was_rub: err.seen,
        now_rub: err.claim.priceRub,
      })
    }
    if (err instanceof SoldOut) {
      // Что предложить проигравшему: другие продавцы того же товара.
      throw conflict('sold_out', 'Товар только что раскупили', {
        sku: err.sku,
        alternatives: await alternatives(err.sku, err.offerId),
      })
    }
    throw err
  }
}

/** Что покупаем: конкретное предложение или товар без выбора продавца. */
async function resolveTarget(input: CreateInput) {
  if (input.offerId) {
    const offer = await getOffer(pool, input.offerId)
    if (!offer) throw badRequest('unknown_offer', 'Такого предложения нет')
    return { sku: offer.sku, offerId: offer.id }
  }
  if (!input.sku) throw badRequest('offer_or_sku_required')

  const { rowCount } = await pool.query('select 1 from products where sku = $1', [input.sku])
  if (!rowCount) throw badRequest('unknown_sku', 'Такого товара нет')
  return { sku: input.sku, offerId: null }
}

async function applyPromo(client: Client, order: Order, code: string, priceRub: number) {
  const applied = await promo.reserve(client, code, order.id, priceRub)
  const { rows } = await client.query<Order>(
    `update orders
        set promo_code = $2, discount_rub = $3, total_rub = amount_rub - $3, updated_at = now()
      where id = $1 returning *`,
    [order.id, applied.code, applied.discount],
  )
  return rows[0]!
}

async function withReservation(order: Order) {
  const { rows } = await pool.query<Reservation>(
    'select * from reservations where order_id = $1 and released_at is null',
    [order.id],
  )
  return { order, reservation: rows[0] ?? null }
}

class DuplicateRequest extends Error {}
class SoldOut extends Error {
  constructor(
    readonly sku: string,
    readonly offerId: number,
  ) {
    super('sold_out')
  }
}
class PriceChanged extends Error {
  constructor(
    readonly claim: Claim,
    readonly seen: number,
  ) {
    super('price_changed')
  }
}
