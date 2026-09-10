import { startListener, type Listener } from '../lib/listener.ts'
import { CHANNEL, bySeq, currentSeq, since, type OfferState } from './events.ts'

/**
 * Раздача событий витрины подписчикам.
 *
 * В канал `NOTIFY` уходит только номер события: у него восемь килобайт на
 * сообщение, а состояние лежит в `events`. Поэтому на каждое уведомление идёт
 * чтение одной строки по первичному ключу — так номер, пришедший из канала,
 * всегда доставляется ровно один раз, и никакого курсора для живой раздачи не
 * нужно. Курсор нужен только там, где события шли мимо: при подключении клиента
 * и после обрыва слушателя.
 */

export type Subscriber = { send: (payload: string) => void }

/**
 * Перекрытие при досылке. `bigserial` выдаёт номер при вставке, а не при
 * фиксации, поэтому событие с меньшим номером может зафиксироваться позже уже
 * доставленного. Живой подписчик его всё равно получит — `NOTIFY` срабатывает
 * на фиксации, — а вот досылка «строго больше последнего номера» его пропустит.
 * Отматываем немного назад; повтор безвреден, состояние в событии полное.
 */
const OVERLAP = 50

const subscribers = new Set<Subscriber>()
let listener: Listener | null = null
let lastDelivered = 0

export const subscriberCount = () => subscribers.size
export const listenerAlive = () => listener?.alive() ?? false
export const deliveredSeq = () => lastDelivered

export function subscribe(subscriber: Subscriber) {
  subscribers.add(subscriber)
  return () => subscribers.delete(subscriber)
}

function broadcast(events: OfferState[]) {
  if (!events.length) return
  const payload = JSON.stringify({ type: 'events', events })
  for (const subscriber of subscribers) {
    try {
      subscriber.send(payload)
    } catch {
      subscribers.delete(subscriber)
    }
  }
  for (const event of events) lastDelivered = Math.max(lastDelivered, event.seq)
}

async function onNotify(payload: string) {
  const seq = Number(payload)
  if (!Number.isFinite(seq)) return
  const state = await bySeq(seq)
  if (state) broadcast([state])
}

/**
 * Пока слушатель лежал, события шли мимо. Досылаем страницами, пока не кончатся:
 * одной выборкой ограничиваться нельзя, иначе на длинном обрыве всё, что не
 * влезло в первую страницу, не дойдёт никогда — и цены замрут до тех пор, пока
 * каждый клиент не переподключится сам.
 */
const PAGE = 500

async function resync() {
  let cursor = Math.max(0, lastDelivered - OVERLAP)
  for (;;) {
    const batch = await since(cursor, PAGE)
    if (!batch.length) return
    broadcast(batch)
    cursor = batch[batch.length - 1]!.seq
    if (batch.length < PAGE) return
  }
}

/**
 * Досылка подключившемуся клиенту. Ограничена одной страницей намеренно: если
 * пропущено больше, дешевле и надёжнее взять свежий снимок витрины, поэтому
 * вместе с событиями уходит признак `truncated`.
 */
export async function backlogSince(seq: number) {
  const events = await since(Math.max(0, seq - OVERLAP), PAGE + 1)
  return { events: events.slice(0, PAGE), truncated: events.length > PAGE }
}

export async function start() {
  lastDelivered = await currentSeq()
  listener = startListener({
    channel: CHANNEL,
    onNotify: (payload) => void onNotify(payload),
    onReconnect: () => void resync(),
  })
}

export const stop = () => listener?.stop() ?? Promise.resolve()
