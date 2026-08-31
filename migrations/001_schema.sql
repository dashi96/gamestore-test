-- Товары из материалов ТЗ.
create table products (
  sku        text primary key,
  name       text    not null,
  type       text    not null,
  price_rub  integer not null check (price_rub >= 0),
  image      text
);

create table orders (
  id              text primary key,                    -- ord_xxxxxxxx
  sku             text not null references products(sku),
  status          text not null check (status in (
                    'created','paid','delivering','delivered',
                    'payment_failed','out_of_stock','delivery_failed')),
  amount_rub      integer not null,                    -- цена до скидки
  discount_rub    integer not null default 0,
  total_rub       integer not null,                    -- к оплате, считает только сервер
  promo_code      text,
  -- Защита от двойного клика «Купить»: два запроса с одним ключом дают один заказ.
  idempotency_key text unique,
  status_reason   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index orders_status_idx on orders (status);

-- Журнал вебхуков. Первичный ключ по event_id — это и есть дедупликация
-- повторной доставки (at-least-once): второй INSERT просто не проходит.
-- Строка пишется даже если заказа ещё нет: processed_at остаётся NULL,
-- воркер разберёт такое событие позже (вебхук раньше заказа / не по порядку).
create table payment_events (
  event_id     text primary key,
  order_id     text not null,
  status       text not null,
  amount_rub   integer,
  currency     text,
  payload      jsonb not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz,
  note         text
);
create index payment_events_unprocessed_idx
  on payment_events (received_at) where processed_at is null;

-- Единственный факт выдачи. order_id — первичный ключ, поэтому двух ключей
-- на один заказ не существует физически, чем бы ни закончились гонки.
-- request_id уникален: он детерминирован (req_<order>_<provider>), так что
-- повтор после таймаута приносит тот же самый код от поставщика.
create table deliveries (
  order_id     text primary key references orders(id),
  provider     text not null,
  request_id   text not null unique,
  code         text not null,
  delivered_at timestamptz not null default now()
);

-- Очередь выдачи (outbox). Вебхук её только наполняет и сразу отвечает 200,
-- сама выдача идёт в воркере: at-least-once доставка не должна ждать поставщика.
create table delivery_jobs (
  order_id    text primary key references orders(id),
  provider    text not null default 'a',
  attempts    integer not null default 0,
  next_run_at timestamptz not null default now(),
  locked_at   timestamptz,
  last_error  text,
  created_at  timestamptz not null default now()
);
create index delivery_jobs_due_idx on delivery_jobs (next_run_at);

create table promocodes (
  code       text primary key,
  type       text not null check (type in ('percent','amount')),
  value      integer not null check (value > 0),
  max_uses   integer not null check (max_uses > 0),
  used_count integer not null default 0 check (used_count >= 0),
  constraint promocodes_within_limit check (used_count <= max_uses)
);

create table promo_uses (
  order_id   text primary key references orders(id),
  code       text not null references promocodes(code),
  created_at timestamptz not null default now()
);
