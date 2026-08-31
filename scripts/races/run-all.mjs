// Прогон всех сценариев гонок. Выход с кодом 1, если хоть одна проверка упала.
//
//   docker compose run --rm races          # из контейнера, ничего ставить не надо
//   npm run races                          # с хоста, если стек уже поднят
//   node scripts/races/run-all.mjs 02 06   # только выбранные сценарии

import { API, sleep } from './lib.mjs'

const SCENARIOS = [
  '01-double-click.mjs',
  '02-webhook-storm.mjs',
  '03-repeat-event.mjs',
  '04-out-of-order.mjs',
  '05-empty-pool.mjs',
  '06-timeout-trap.mjs',
  '07-promo-limit.mjs',
  '08-chaos.mjs',
]

const filters = process.argv.slice(2)
const selected = filters.length
  ? SCENARIOS.filter((file) => filters.some((f) => file.startsWith(f) || file.includes(f)))
  : SCENARIOS

await waitForApi()

let failed = 0
const started = Date.now()

for (const file of selected) {
  const scenario = await import(`./${file}`)
  const label = `${file.slice(0, 2)}. ${scenario.name}`
  process.stdout.write(`\n${label}\n${'─'.repeat(Math.min(label.length, 100))}\n`)

  const t0 = Date.now()
  let checks
  try {
    checks = await scenario.run()
  } catch (err) {
    failed++
    console.log(`  ✗ сценарий упал: ${err.message}`)
    continue
  }

  for (const check of checks) {
    if (check.ok) {
      console.log(`  ✓ ${check.label}`)
    } else {
      failed++
      console.log(`  ✗ ${check.label} — получено ${fmt(check.actual)}, ожидалось ${fmt(check.expected)}`)
    }
  }
  console.log(`  · ${((Date.now() - t0) / 1000).toFixed(1)} с`)
}

const seconds = ((Date.now() - started) / 1000).toFixed(1)
console.log(
  failed === 0
    ? `\nВсе проверки пройдены за ${seconds} с\n`
    : `\nПровалено проверок: ${failed} (за ${seconds} с)\n`,
)
process.exit(failed === 0 ? 0 : 1)

function fmt(value) {
  return typeof value === 'string' ? `"${value}"` : JSON.stringify(value)
}

async function waitForApi() {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`${API}/health`)
      if (response.ok) return
    } catch {}
    await sleep(500)
  }
  throw new Error(`API недоступен: ${API}`)
}
