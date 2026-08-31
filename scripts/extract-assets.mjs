// Достаёт картинки из макета (design/design.fig) в web/assets под понятными именами.
// .fig — это zip: canvas.fig (бинарь Figma) + images/<sha1> без расширений.
// Соответствие «хеш → имя» составлено вручную по контрольному листу изображений.
//
// Скрипт разовый и для работы приложения не нужен: web/assets уже в репозитории.
// Он лежит здесь как документация происхождения картинок — видно, что они взяты
// из макета, а не подобраны похожие. Сам макет не коммитится (файл заказчика),
// поэтому без него скрипт просто скажет, куда его положить.
import { execFileSync } from 'node:child_process'
import { mkdirSync, copyFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fig = join(root, 'design/design.fig')
const tmp = join(root, '.fig-unpack')
const out = join(root, 'web/assets')

const MAP = {
  // иконки сервисов (ряд под баннером)
  caf4de205beb695df8c399fbd9bcfff259c22dd6: 'services/steam.png',
  '928d9b568165041ec68a4ba894cb53e7f3d47360': 'services/telegram.png',
  '78bb25bd59b9a58a898c7b10613b6fbe38f9eb62': 'services/roblox.png',
  bcfa27e0b783a61ba2ebe3e065121028ac65965d: 'services/brawl-stars.png',
  fec7c0737fc84d914b4af27d256b9a251f294983: 'services/pubg-mobile.png',
  '271824c057d7eee1b2c58bed5b056a444e91fc97': 'services/app-store.png',
  e520e500c0ed6e658a454766b036ecf80b97b5ad: 'services/chatgpt.png',
  fd6a7cf0628bf2ee05bfbb9f0595ed8c32798a78: 'services/playstation.png',
  '7807f3eff00752295ce28f2047a00c5320a180a2': 'services/tiktok.png',
  '239b886375da4861daaafe72d135372d1ce1880f': 'services/mobile-legends.png',
  // обложки товаров
  b11dda95e50ca1cad75f59f6437d954625460329: 'products/pubg.jpg',
  '47b20e66c7e445c04d13e566e143c77b7931bd5e': 'products/wildcat.png',
  '510ba00c9d2fc5d73ad0308ea55feddac3538442': 'products/rogue-company.png',
  '52d5daaf4502e13baf2ec1c726366f7a67e57b91': 'products/zombie-army.png',
  // иконки интерфейса
  '4ca5aba8bf1b56b819e9e8372a3bea27cf6fbf95': 'ui/basket.png',
  '6faa027275849f60b782c241693419554659a9e9': 'ui/wallet.png',
  '7807bbf9753c75b1d475a2784a6220773b18f55b': 'ui/percent.png',
  f74fef1d179df68e3bb6d6918447957dcba96d06: 'ui/lightning.png',
  '6ef39617679ab1f4af0f4ddfd032db811c795470': 'ui/squares.png',
  '0b419f59f41e3f5c4987c8dcb41d8af581966ec8': 'ui/robot.png',
  '31dcc20409c070f02bb0c369c7f2a147167d263d': 'ui/coin.png',
  '83080afc4ab79d6c01c0353ee11aaefdb9c2be51': 'ui/avatar.jpg',
}

if (!existsSync(fig)) {
  console.error(
    [
      'Макет не найден: ' + fig,
      '',
      'Этот скрипт нужен, только чтобы пересобрать картинки из исходного .fig.',
      'Готовые ассеты уже лежат в web/assets и коммитятся вместе с кодом —',
      'для запуска приложения ничего делать не нужно.',
      '',
      'Чтобы всё-таки пересобрать: положите файл макета в design/design.fig',
      'и повторите npm run assets.',
    ].join('\n'),
  )
  process.exit(1)
}

rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })
execFileSync('unzip', ['-qo', fig, '-d', tmp])

for (const dir of ['services', 'products', 'ui']) mkdirSync(join(out, dir), { recursive: true })

const present = new Set(readdirSync(join(tmp, 'images')))
let copied = 0
for (const [hash, name] of Object.entries(MAP)) {
  if (!present.has(hash)) {
    console.warn(`пропущен ${name}: нет ${hash} в макете`)
    continue
  }
  copyFileSync(join(tmp, 'images', hash), join(out, name))
  copied++
}
rmSync(tmp, { recursive: true, force: true })
console.log(`скопировано ${copied} из ${Object.keys(MAP).length}, всего в макете ${present.size}`)
