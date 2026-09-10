-- Второй этап: у магазина появляется склад.
--
-- В первом этапе остатка в базе не было вовсе — он жил в памяти заглушки
-- поставщика. «Последняя единица», «бронь под два заказа» и «кнопка гаснет
-- у всех» — это утверждения про склад, поэтому склад обязан быть строками
-- в базе, а не счётчиком на той стороне.

create table sellers (
  id          text primary key,
  name        text not null,
  -- Продавцов больше, чем поставщиков: витрине нужны разные предложения на один
  -- товар («возьмите у другого продавца»), а код по-прежнему выдают двое.
  provider_id text not null check (provider_id in ('a', 'b'))
);

create table offers (
  id        bigserial primary key,
  sku       text    not null references products(sku),
  seller_id text    not null references sellers(id),
  price_rub integer not null check (price_rub >= 0)
);
create unique index offers_sku_seller_uniq on offers (sku, seller_id);
create index offers_sku_idx on offers (sku);
-- Ключ для листания выдачи поиска без OFFSET.
create index offers_price_idx on offers (price_rub, id);

-- Единица склада. code_ref — слот кода у поставщика: /issue отдаёт именно его,
-- поэтому «база говорит доступно, а кода нет» перестаёт быть возможным само
-- собой, без сверок и синхронизаций.
--
-- held_by_order — текущий держатель брони, и он живёт ЗДЕСЬ, а не выводится из
-- таблицы броней, по неочевидной причине. `SELECT ... FOR UPDATE` перепроверяет
-- условие выборки только по строкам своей таблицы: если признак занятости лежит
-- в другой таблице, транзакция со старым снимком возьмёт блокировку уже
-- освобождённой строки и не увидит, что конкурент успел её забронировать.
-- Условие целиком на строке склада — и повторная проверка при блокировке
-- работает. Таблица броней остаётся историей и подробностями (цена, сроки,
-- причина снятия), а не источником ответа «свободна ли единица».
create table stock_units (
  id            bigserial primary key,
  offer_id      bigint not null references offers(id),
  code_ref      text   not null unique,
  held_by_order text   references orders(id),
  sold_order_id text   references orders(id)
);
create unique index stock_units_sold_uniq on stock_units (sold_order_id)
  where sold_order_id is not null;
create unique index stock_units_held_uniq on stock_units (held_by_order)
  where held_by_order is not null;
-- Частичный индекс по свободным: захват единицы ходит только по ним.
create index stock_units_free_idx on stock_units (offer_id)
  where sold_order_id is null and held_by_order is null;

-- Бронь. Живёт отдельно от единицы намеренно: единица хранит только факт
-- продажи, а история броней (кто держал, когда снялась, почему) остаётся целой.
create table reservations (
  id              bigserial primary key,
  unit_id         bigint      not null references stock_units(id),
  order_id        text        not null references orders(id),
  -- Цена фиксируется на срок брони: в этом её смысл. Подорожание на витрине
  -- забронировавшего уже не касается.
  price_rub       integer     not null check (price_rub >= 0),
  expires_at      timestamptz not null,
  -- Потолок для заказа, ушедшего в оплату: платёж в полёте не должен потерять
  -- товар, но и запирать единицу навсегда зависший платёж не имеет права.
  hard_expires_at timestamptz not null,
  released_at     timestamptz,
  release_reason  text
);
-- Страховка на случай, если рассуждение о блокировках окажется неверным:
-- один товар не уходит в две брони, один заказ не держит две единицы.
create unique index reservations_unit_active  on reservations (unit_id)  where released_at is null;
create unique index reservations_order_active on reservations (order_id) where released_at is null;
create index reservations_due_idx on reservations (expires_at) where released_at is null;

-- Корзина. Количества нет намеренно: каждое предложение — это конкретный лот
-- конкретного продавца, а заказ бронирует ровно одну единицу и получает ровно
-- один код. Количество потребовало бы N броней на заказ, N кодов в выдаче и
-- отсчёта на каждую единицу — этого ТЗ не просит.
--
-- price_seen_rub — цена, которую покупатель видел в момент, когда клал товар в
-- корзину. В расчёте суммы она НЕ участвует: сумму всегда диктует offers.
-- Нужна ровно для двух вещей — показать «цена изменилась» после перезагрузки
-- страницы и отказать при оформлении по устаревшей цене.
create table cart_items (
  cart_id        uuid        not null,
  offer_id       bigint      not null references offers(id),
  price_seen_rub integer     not null check (price_seen_rub >= 0),
  added_at       timestamptz not null default now(),
  primary key (cart_id, offer_id)
);
create index cart_items_added_idx on cart_items (added_at);

-- Журнал изменений витрины. Событие несёт ПОЛНОЕ состояние оффера, а не
-- приращение: тогда повторная и запоздавшая доставка безвредна, и дыры в
-- нумерации (bigserial выдаёт номер до фиксации) ничего не ломают.
create table events (
  seq        bigserial primary key,
  offer_id   bigint      not null references offers(id),
  state      jsonb       not null,
  created_at timestamptz not null default now()
);
create index events_offer_idx on events (offer_id, seq desc);

-- Заказ теперь покупается у конкретного продавца, а не просто «товар sku».
alter table orders add column offer_id bigint references offers(id);

-- Два новых состояния:
--   awaiting_payment  — нажали «оплатить», бронь держится до hard_expires_at;
--   reservation_expired — бронь истекла раньше, чем платёж начался.
alter table orders drop constraint orders_status_check;
alter table orders add constraint orders_status_check check (status in (
  'created','awaiting_payment','paid','delivering','delivered',
  'payment_failed','out_of_stock','delivery_failed','reservation_expired'
));

-- Поиск по названию. Индекс ставится сразу, но замер «с ним и без него»
-- останется в README: на нынешнем размере каталога он может ничего не решать.
create extension if not exists pg_trgm;
create index products_name_trgm on products using gin (name gin_trgm_ops);
