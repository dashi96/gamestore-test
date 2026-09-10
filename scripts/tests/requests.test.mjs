import assert from 'node:assert/strict'
import test from 'node:test'
import { createGate } from '../../web/js/requests.js'

test('ответы, пришедшие по порядку, применяются все', () => {
  const gate = createGate()
  const a = gate.next()
  const b = gate.next()
  assert.equal(gate.accept(a), true)
  assert.equal(gate.accept(b), true)
})

test('устаревший ответ не перетирает более свежий', () => {
  const gate = createGate()
  const first = gate.next()
  const second = gate.next()
  // Второй запрос ответил раньше первого — так и бывает при быстром вводе.
  assert.equal(gate.accept(second), true)
  assert.equal(gate.accept(first), false)
})

test('повторный ответ с тем же талоном отбрасывается', () => {
  const gate = createGate()
  const ticket = gate.next()
  assert.equal(gate.accept(ticket), true)
  assert.equal(gate.accept(ticket), false)
})

test('побеждает последний отправленный, а не последний пришедший', () => {
  const gate = createGate()
  const tickets = Array.from({ length: 8 }, () => gate.next())
  // Ответы приходят вразнобой; применённым должен остаться самый свежий.
  const arrival = [3, 7, 1, 8, 2, 6, 4, 5].map((n) => tickets[n - 1])
  const applied = arrival.filter((ticket) => gate.accept(ticket))
  assert.deepEqual(applied, [3, 7, 8])
  assert.equal(gate.stats().applied, 8)
})

test('мусорный талон не проходит', () => {
  const gate = createGate()
  assert.equal(gate.accept(undefined), false)
  assert.equal(gate.accept(1.5), false)
  assert.equal(gate.accept(-1), false)
})
