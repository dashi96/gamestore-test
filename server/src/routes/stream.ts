import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import { currentSeq } from '../core/events.ts'
import { backlogSince, subscribe } from '../core/stream.ts'

/**
 * Живая витрина.
 *
 * Вебсокет, а не SSE, по одной причине: браузер держит шесть HTTP/1.1-соединений
 * на origin, общих на все вкладки. На десяти открытых вкладках шесть работали
 * бы, а четыре повисли в очереди сокет-пула — без события `error`, то есть без
 * шанса на переподключение, и с той же статики не загрузилась бы даже страница.
 * У вебсокета этот потолок измеряется сотнями.
 *
 * Докрутка по `from_seq` — наша, в параметре запроса, а не протокольная, так что
 * от смены транспорта она не зависела.
 */

const HEARTBEAT_MS = 15_000

export async function streamRoutes(app: FastifyInstance) {
  const live = new Set<WebSocket & { isAlive?: boolean }>()

  // Молчащее соединение может быть уже мёртвым, но не закрытым: промежуточные
  // прокси рвут простой тихо. Кадры ping/pong — часть протокола, писать нечего.
  const heartbeat = setInterval(() => {
    for (const socket of live) {
      if (socket.isAlive === false) {
        socket.terminate()
        live.delete(socket)
        continue
      }
      socket.isAlive = false
      socket.ping()
    }
  }, HEARTBEAT_MS)

  app.addHook('onClose', async () => clearInterval(heartbeat))

  app.get('/api/stream', { websocket: true }, async (socket: WebSocket, request) => {
    const { from_seq } = request.query as { from_seq?: string }
    const fromSeq = Number(from_seq ?? 0)

    const tagged = socket as WebSocket & { isAlive?: boolean }
    tagged.isAlive = true
    socket.on('pong', () => {
      tagged.isAlive = true
    })
    live.add(tagged)

    const unsubscribe = subscribe({ send: (payload) => socket.send(payload) })
    const drop = () => {
      unsubscribe()
      live.delete(tagged)
    }
    socket.on('close', drop)
    socket.on('error', drop)

    socket.send(JSON.stringify({ type: 'hello', seq: await currentSeq() }))

    // Подписка оформлена раньше досылки намеренно: пришедшее за это время живое
    // событие свежее досылаемого, а клиент применяет по максимуму номера на
    // предложение — старое он отбросит сам.
    if (Number.isFinite(fromSeq) && fromSeq > 0) {
      const backlog = await backlogSince(fromSeq)
      if (backlog.events.length) {
        socket.send(JSON.stringify({ type: 'events', events: backlog.events }))
      }
      // Пропущено больше страницы: досылать хвост дороже, чем взять снимок заново.
      if (backlog.truncated) socket.send(JSON.stringify({ type: 'resnapshot' }))
    }
  })
}
