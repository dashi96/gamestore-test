/**
 * Состояние витрины на клиенте.
 *
 * Событие несёт полное состояние предложения, а не приращение, поэтому
 * применяется одно правило: побеждает больший номер на каждое предложение
 * отдельно. Из этого следует всё остальное — повтор безвреден, порядок прихода
 * не важен, снимок и поток можно применять в любой последовательности, а после
 * обрыва достаточно досылки с перекрытием.
 */

const offers = new Map()
const listeners = new Set()
let snapshotSeq = 0

/** Номер, с которого продолжать поток после переподключения. */
export const seq = () => snapshotSeq

export const get = (offerId) => offers.get(Number(offerId)) ?? null

export function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(changed) {
  if (!changed.length) return
  for (const listener of listeners) listener(changed)
}

function put(state) {
  const known = offers.get(state.offer_id)
  // Старое состояние приходит и в норме: досылка идёт с перекрытием назад.
  if (known && known.seq >= state.seq) return false
  offers.set(state.offer_id, state)
  return true
}

/** Снимок с сервера: список предложений и номер, на котором он снят. */
export function applySnapshot({ seq: at, offers: list }) {
  snapshotSeq = Math.max(snapshotSeq, at ?? 0)
  const changed = []
  for (const offer of list ?? []) {
    if (put({ ...offer, seq: offer.seq ?? at ?? 0 })) changed.push(offer.offer_id)
  }
  notify(changed)
}

export function applyEvents(events) {
  const changed = []
  for (const event of events) {
    snapshotSeq = Math.max(snapshotSeq, event.seq)
    if (put(event)) changed.push(event.offer_id)
  }
  notify(changed)
}
