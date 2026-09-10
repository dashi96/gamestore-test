import { API, adminOffers, checker, ensureStock, openDb, openStream, reset, setPrice, waitUntil } from './lib.mjs'

export const name = 'Обрыв слушателя LISTEN: витрина не остаётся молча со старыми ценами'

const SKU = 'STEAM-TOPUP-2500'

const health = async () => {
  const response = await fetch(`${API}/health`)
  return { code: response.status, ...(await response.json()) }
}

/** Номер последнего записанного события — точка отсчёта для «ничего не потеряно». */
async function lastSeq() {
  const db = await openDb()
  try {
    const { rows } = await db.query('select coalesce(max(seq), 0)::int as seq from events')
    return rows[0].seq
  } finally {
    await db.end()
  }
}

async function seqsAfter(seq) {
  const db = await openDb()
  try {
    const { rows } = await db.query('select seq::int as seq from events where seq > $1 order by seq', [seq])
    return rows.map((row) => row.seq)
  } finally {
    await db.end()
  }
}

export async function run() {
  const c = checker()
  await reset()
  await ensureStock(SKU, 2)
  const [offer] = await adminOffers(SKU)

  const watcher = await openStream()
  const before = await health()
  c.eq('поток живой', before.listener, 'alive')
  c.eq('и здоровье отвечает 200', before.code, 200)

  // Рвём соединение слушателя со стороны базы — так же выглядит сетевой сбой.
  const db = await openDb()
  let killed = 0
  try {
    const { rows } = await db.query(
      `select count(pg_terminate_backend(pid))::int as killed
         from pg_stat_activity where query ilike 'listen%'`,
    )
    killed = rows[0].killed
  } finally {
    await db.end()
  }
  c.ok('соединение слушателя оборвано', killed >= 1, `оборвано: ${killed}`)

  const down = await waitUntil(health, (h) => h.listener === 'down', { timeoutMs: 3000, everyMs: 50 })
  c.eq('обрыв виден снаружи, а не только в логах', down.listener, 'down')
  c.eq('и health отвечает 503, а не 200', down.code, 503)

  // Меняем цены, пока связь не восстановилась. Проверять «подписчик ничего не
  // получил» бессмысленно: слушатель поднимается за доли секунды, и часть
  // событий успевает пройти живьём. Гарантия здесь другая и она сильнее —
  // не потеряно ни одного события, а повторы безвредны.
  const fromSeq = await lastSeq()
  await setPrice(offer.id, offer.price_rub + 300)
  await setPrice(offer.id, offer.price_rub + 600)

  const back = await waitUntil(health, (h) => h.listener === 'alive', { timeoutMs: 15_000, everyMs: 100 })
  c.eq('слушатель переподключился сам', back.listener, 'alive')
  c.eq('и здоровье снова 200', back.code, 200)

  const caughtUp = await waitUntil(
    async () => watcher.latest(offer.id),
    (state) => state?.price_rub === offer.price_rub + 600,
    { timeoutMs: 8000 },
  )
  c.eq('пропущенное досылается после восстановления', caughtUp?.price_rub, offer.price_rub + 600)

  const written = await seqsAfter(fromSeq)
  const delivered = new Set(watcher.events.map((event) => event.seq))
  const lost = written.filter((seq) => !delivered.has(seq))
  c.eq('ни одно событие не потеряно', lost.length, 0)
  c.ok('повторная доставка допустима и состояние не портит',
    watcher.events.length >= written.length,
    `записано ${written.length}, доставлено ${watcher.events.length}`)

  // И поток снова живой, без переподключения клиента.
  await setPrice(offer.id, offer.price_rub + 900)
  const live = await waitUntil(
    async () => watcher.latest(offer.id),
    (state) => state?.price_rub === offer.price_rub + 900,
    { timeoutMs: 5000 },
  )
  c.eq('новые события идут как прежде', live?.price_rub, offer.price_rub + 900)

  watcher.close()
  return c.checks
}
