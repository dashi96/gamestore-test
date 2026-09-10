import { applyEvents, seq } from './store.js'

/**
 * Живая витрина.
 *
 * Вебсокет, а не SSE: браузер держит шесть HTTP/1.1-соединений на origin, общих
 * на все вкладки, и на десяти открытых вкладках четыре повисли бы в очереди
 * сокет-пула — без события `error`, то есть без шанса переподключиться.
 *
 * Переподключение с нарастающей паузой, и при каждом — свой последний номер:
 * пропущенное за время обрыва сервер дошлёт.
 */

const MAX_DELAY_MS = 10_000

export function connect(onStatus = () => {}, onResnapshot = () => {}) {
  let socket = null
  let attempt = 0
  let stopped = false
  let retryTimer = null

  const url = () => {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    return `${scheme}://${location.host}/api/stream?from_seq=${seq()}`
  }

  const open = () => {
    if (stopped) return
    // Отложенная попытка могла быть уже назначена: без её отмены возврат на
    // вкладку открывал бы второе соединение поверх первого, и на каждом цикле
    // «свернул — развернул» число живых сокетов удваивалось.
    clearTimeout(retryTimer)
    retryTimer = null
    if (socket && socket.readyState <= WebSocket.OPEN) return
    socket = new WebSocket(url())

    socket.addEventListener('open', () => {
      attempt = 0
      onStatus('live')
    })

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.type === 'events') applyEvents(message.events)
      // Пропущено больше, чем сервер готов дослать: берём снимок заново.
      if (message.type === 'resnapshot') onResnapshot()
    })

    const retry = () => {
      if (stopped) return
      onStatus('offline')
      const delay = Math.min(2 ** attempt * 300, MAX_DELAY_MS)
      attempt++
      retryTimer = setTimeout(open, delay)
    }

    socket.addEventListener('close', retry)
    socket.addEventListener('error', () => socket.close())
  }

  open()
  // Вкладка могла проспать обрыв: при возврате проверяем соединение сразу,
  // не дожидаясь очередной паузы.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && socket && socket.readyState > WebSocket.OPEN) {
      attempt = 0
      open()
    }
  })

  return () => {
    stopped = true
    clearTimeout(retryTimer)
    socket?.close()
  }
}
