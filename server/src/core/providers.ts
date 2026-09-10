import { config, type ProviderId } from '../lib/config.ts'

export type IssueOutcome =
  | { kind: 'ok'; code: string }
  | { kind: 'out_of_stock' }
  /**
   * Исход неизвестен: таймаут, обрыв, 5xx. Код мог быть уже выдан, а ответ
   * не дошёл. Повторять можно только тот же request_id тому же поставщику.
   */
  | { kind: 'ambiguous'; error: string }

export async function issue(
  provider: ProviderId,
  /**
   * unit_ref — слот кода, закреплённый за единицей склада. Поставщик обязан
   * отдать по нему один и тот же код: тогда «база говорит доступно, а кода нет»
   * не может возникнуть случайно, а не только не должно.
   */
  payload: { request_id: string; sku: string; order_id: string; unit_ref: string | null },
): Promise<IssueOutcome> {
  const url = `${config.providers[provider]}/issue`
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.providerTimeoutMs),
    })

    if (response.ok) {
      const body = (await response.json()) as { code?: string }
      if (!body.code) return { kind: 'ambiguous', error: 'no_code_in_response' }
      return { kind: 'ok', code: body.code }
    }

    const body = (await response.json().catch(() => ({}))) as { reason?: string }
    // Единственный однозначный отказ: у поставщика физически нет ключей.
    // Только он даёт право уйти к резервному поставщику.
    if (body.reason === 'out_of_stock') return { kind: 'out_of_stock' }
    return { kind: 'ambiguous', error: `http_${response.status}:${body.reason ?? 'unknown'}` }
  } catch (err) {
    return { kind: 'ambiguous', error: err instanceof Error ? err.name : 'network_error' }
  }
}

export async function adminFetch(provider: ProviderId, path: string, init?: RequestInit) {
  const response = await fetch(`${config.providers[provider]}${path}`, {
    ...init,
    // POST без тела + application/json = 400 у fastify, поэтому пустой объект
    body: init?.method === 'POST' ? (init.body ?? '{}') : init?.body,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.adminToken}`,
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(5000),
  })
  return response.json()
}
