const num = (v: string | undefined, fallback: number) => (v === undefined ? fallback : Number(v))

export const config = {
  port: num(process.env.PORT, 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://shop:shop@localhost:5433/shop',
  adminToken: process.env.ADMIN_TOKEN ?? 'admin-token',
  providers: {
    a: process.env.PROVIDER_A_URL ?? 'http://localhost:4001',
    b: process.env.PROVIDER_B_URL ?? 'http://localhost:4002',
  },
  /** Через сколько считаем ответ поставщика недошедшим. Таймаут ≠ отказ. */
  providerTimeoutMs: num(process.env.PROVIDER_TIMEOUT_MS, 2000),
  /** Сколько раз дёргаем поставщика при неоднозначном исходе, прежде чем уйти в delivery_failed. */
  maxDeliveryAttempts: num(process.env.MAX_DELIVERY_ATTEMPTS, 5),
  /** Своё имя для вебхука платёжки-заглушки. */
  selfUrl: process.env.SELF_URL ?? `http://localhost:${num(process.env.PORT, 3000)}`,
  /** Срок брони: столько времени товар держится за покупателем на оформлении. */
  reservationTtlSec: num(process.env.RESERVATION_TTL_SEC, 420),
  /**
   * Потолок для заказа, ушедшего в оплату. Платёж в полёте не должен потерять
   * товар из-за истёкшего отсчёта, но и запирать единицу навсегда зависший
   * платёж не имеет права.
   */
  reservationHardTtlSec: num(process.env.RESERVATION_HARD_TTL_SEC, 1200),
  /** Как часто воркер снимает просроченные брони. */
  sweepIntervalMs: num(process.env.SWEEP_INTERVAL_MS, 250),
}

export type ProviderId = 'a' | 'b'
