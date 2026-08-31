insert into products (sku, name, type, price_rub, image) values
  ('STEAM-TOPUP-500',  'Пополнение Steam 500 ₽',         'topup',        500,  'assets/services/steam.png'),
  ('STEAM-TOPUP-1000', 'Пополнение Steam 1000 ₽',        'topup',        1000, 'assets/services/steam.png'),
  ('STEAM-TOPUP-2500', 'Пополнение Steam 2500 ₽',        'topup',        2500, 'assets/services/steam.png'),
  ('KEY-CS2-PRIME',    'CS2 Prime Status ключ',          'key',          1290, 'assets/products/pubg.jpg'),
  ('KEY-GTA5',         'GTA V ключ активации',           'key',          1990, 'assets/products/wildcat.png'),
  ('KEY-EFT',          'Escape from Tarkov ключ',        'key',          3490, 'assets/products/rogue-company.png'),
  ('SUB-DISCORD-1M',   'Discord Nitro 1 месяц',          'subscription', 399,  'assets/products/zombie-army.png'),
  ('SUB-YT-3M',        'YouTube Premium 3 месяца',       'subscription', 1490, 'assets/products/pubg.jpg'),
  ('SUB-SPOTIFY-1M',   'Spotify Premium 1 месяц',        'subscription', 299,  'assets/products/wildcat.png'),
  ('GIFT-PSN-1000',    'PlayStation Store карта 1000 ₽', 'giftcard',     1000, 'assets/services/playstation.png'),
  ('GIFT-XBOX-1500',   'Xbox Gift Card 1500 ₽',          'giftcard',     1500, 'assets/products/zombie-army.png'),
  ('GIFT-ROBLOX-800',  'Roblox 800 Robux',               'giftcard',     890,  'assets/services/roblox.png')
on conflict (sku) do nothing;

insert into promocodes (code, type, value, max_uses) values
  ('WELCOME10', 'percent', 10,  100),
  ('GG500',     'amount',  500, 20),
  ('LIMIT3',    'percent', 25,  3),
  ('ONCEONLY',  'percent', 50,  1)
on conflict (code) do nothing;
