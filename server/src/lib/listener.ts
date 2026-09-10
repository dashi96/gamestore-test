import pg from 'pg'
import { config } from './config.ts'

/**
 * Слушатель `LISTEN` на отдельном соединении: держать его в пуле нельзя, оно
 * занято постоянно.
 *
 * Главное здесь — переподключение и признак живости. Оборвавшийся слушатель
 * ничего не ломает видимым образом: страницы открываются, запросы проходят,
 * в логах пусто, — просто витрина у всех замирает на старых ценах. Такую
 * поломку без явного признака ищут часами, поэтому он выведен в `/health`,
 * а после восстановления связи подписчикам досылается пропущенное.
 */

export type Listener = {
  alive: () => boolean
  stop: () => Promise<void>
}

export function startListener(options: {
  channel: string
  onNotify: (payload: string) => void
  /** Вызывается после восстановления связи: за время обрыва события терялись. */
  onReconnect: () => void
}): Listener {
  let client: pg.Client | null = null
  let alive = false
  let stopped = false
  let attempt = 0
  let everConnected = false

  const log = (message: string, extra: Record<string, unknown> = {}) =>
    console.log(JSON.stringify({ listener: options.channel, message, ...extra }))

  const scheduleReconnect = () => {
    if (stopped) return
    alive = false
    const delayMs = Math.min(2 ** attempt * 250, 10_000)
    attempt++
    setTimeout(() => void connect(), delayMs)
  }

  async function connect() {
    if (stopped) return
    const next = new pg.Client({ connectionString: config.databaseUrl })
    // Обработчик вешается до connect: соединение может отвалиться и на нём.
    next.on('error', (err) => {
      log('оборвалось', { error: String(err) })
      next.removeAllListeners()
      next.end().catch(() => {})
      if (client === next) client = null
      scheduleReconnect()
    })

    try {
      await next.connect()
      await next.query(`listen ${options.channel}`)
    } catch (err) {
      log('подключиться не удалось', { error: String(err), attempt })
      next.removeAllListeners()
      next.end().catch(() => {})
      scheduleReconnect()
      return
    }

    next.on('notification', (message) => {
      if (message.payload) options.onNotify(message.payload)
    })

    client = next
    alive = true
    attempt = 0
    log('подключён')
    // При первом подключении досылать нечего, а вот после обрыва — есть.
    if (everConnected) options.onReconnect()
    everConnected = true
  }

  void connect()

  return {
    alive: () => alive,
    stop: async () => {
      stopped = true
      alive = false
      await client?.end().catch(() => {})
    },
  }
}
