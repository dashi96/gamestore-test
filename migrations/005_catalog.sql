-- Наполнение каталога. По ТЗ второго этапа склад и наполнение делаются
-- самостоятельно, а задача про мгновенный поиск требует «тысячи предложений»,
-- поэтому каталог генерируется, а не перечисляется руками.
--
-- 40 сервисов × 5 видов товара × варианты = около 760 товаров,
-- у 4 продавцов на них ≈ 2300 предложений и ≈ 8000 единиц склада.
-- Двенадцать товаров из первого этапа остаются на месте и получают предложения
-- наравне с остальными, поэтому витрина первого этапа продолжает работать.

insert into sellers (id, name, provider_id) values
  ('gg',    'GG Store',   'a'),
  ('keyz',  'KeyZone',    'a'),
  ('digi',  'DigiMarket', 'b'),
  ('turbo', 'TurboKeys',  'b')
on conflict (id) do nothing;

with base(title) as (values
  ('Steam'), ('PlayStation Store'), ('Xbox'), ('Nintendo eShop'), ('Roblox'),
  ('Minecraft'), ('Discord Nitro'), ('YouTube Premium'), ('Spotify'),
  ('Telegram Premium'), ('ChatGPT Plus'), ('App Store'), ('Google Play'),
  ('Netflix'), ('Twitch'), ('CS2'), ('Dota 2'), ('PUBG Mobile'),
  ('Brawl Stars'), ('Mobile Legends'), ('Genshin Impact'), ('Honkai Star Rail'),
  ('Valorant'), ('Fortnite'), ('Apex Legends'), ('Call of Duty'),
  ('Battlefield 2042'), ('Rainbow Six Siege'), ('Rocket League'), ('GTA V'),
  ('Red Dead Redemption 2'), ('Cyberpunk 2077'), ('The Witcher 3'),
  ('Elden Ring'), ('Baldurs Gate 3'), ('Hogwarts Legacy'), ('EA FC 25'),
  ('World of Tanks'), ('Warface'), ('Escape from Tarkov')
),
b as (select title, row_number() over () as ord from base),
img(arr) as (values (array[
  'assets/services/steam.png',      'assets/services/telegram.png',
  'assets/services/roblox.png',     'assets/services/brawl-stars.png',
  'assets/services/pubg-mobile.png','assets/services/app-store.png',
  'assets/services/chatgpt.png',    'assets/services/playstation.png',
  'assets/services/tiktok.png',     'assets/services/mobile-legends.png',
  'assets/products/pubg.jpg',       'assets/products/rogue-company.png',
  'assets/products/wildcat.png',    'assets/products/zombie-army.png'
])),
kind(code, type, tpl, unit) as (values
  ('TOP', 'topup',        'Пополнение %1$s %2$s ₽',        'top'),
  ('KEY', 'key',          '%1$s — ключ активации (%2$s)',  'key'),
  ('SUB', 'subscription', '%1$s — подписка на %2$s мес.',  'sub'),
  ('GFT', 'giftcard',     '%1$s — подарочная карта %2$s ₽','gift'),
  ('CUR', 'currency',     '%1$s — %2$s игровой валюты',    'cur')
),
variant(unit, idx, label, price) as (values
  ('top',  1, '500',    500),  ('top',  2, '1000',   1000),
  ('top',  3, '2500',   2500), ('top',  4, '5000',   5000),
  ('key',  1, 'Global', 1290), ('key',  2, 'Россия', 990),
  ('key',  3, 'СНГ',    1150),
  ('sub',  1, '1',      399),  ('sub',  2, '3',      999),
  ('sub',  3, '6',      1790), ('sub',  4, '12',     3190),
  ('gift', 1, '1000',   1000), ('gift', 2, '1500',   1500),
  ('gift', 3, '3000',   3000), ('gift', 4, '5000',   5000),
  ('cur',  1, '1 000',  190),  ('cur',  2, '5 000',  890),
  ('cur',  3, '12 000', 1990), ('cur',  4, '30 000', 4490)
)
insert into products (sku, name, type, price_rub, image)
select format('%s-%s-%s', k.code, b.ord, v.idx),
       format(k.tpl, b.title, v.label),
       k.type,
       -- Разброс цен между сервисами: иначе фильтр по цене нечего фильтровать.
       v.price + (b.ord * 17) % 400,
       img.arr[1 + (b.ord % 14)]
  from b
 cross join img
 cross join kind k
  join variant v on v.unit = k.unit
    on conflict (sku) do nothing;

-- Предложения: у одного товара несколько продавцов с разными ценами — без этого
-- нечего предложить проигравшему гонку за последней единицей.
with p as (select sku, price_rub, row_number() over (order by sku) as pord from products),
     s as (select id, row_number() over (order by id) as sord from sellers)
insert into offers (sku, seller_id, price_rub)
select p.sku,
       s.id,
       greatest(1, p.price_rub + p.price_rub * (((p.pord * 7 + s.sord * 13) % 11) - 5) / 100)
  from p cross join s
 -- У товара 2, 3 или 4 продавца, и состав меняется от товара к товару. Двое как
 -- минимум — обязательное условие: проигравшему гонку нужно что-то предложить.
 where ((s.sord - 1 + p.pord) % 4) < 2 + p.pord % 3
    on conflict (sku, seller_id) do nothing;

-- Единицы склада. Три группы намеренно: пустые предложения (кнопка обязана быть
-- погашена сразу), предложения ровно с одной единицей (в них идёт гонка за
-- последней) и обычные с запасом.
with o as (select id, row_number() over (order by id) as oord from offers)
insert into stock_units (offer_id, code_ref)
select o.id, format('u_%s_%s', o.id, g)
  from o
 cross join lateral generate_series(1, case
         when o.oord % 23 = 0 then 0
         when o.oord % 17 = 0 then 1
         else 1 + (o.oord % 6)
       end) as g
    on conflict (code_ref) do nothing;
