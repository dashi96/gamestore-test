/** (2) Меню «Каталог»: клик открывает, повторный клик или клик вне — закрывает. */
export function initCatalog({ button, menu }) {
  const setOpen = (open) => {
    menu.dataset.open = String(open)
    button.setAttribute('aria-expanded', String(open))
  }

  button.addEventListener('click', (event) => {
    event.stopPropagation()
    setOpen(menu.dataset.open !== 'true')
  })

  // Клик внутри самого меню не должен его закрывать.
  menu.addEventListener('click', (event) => event.stopPropagation())

  document.addEventListener('click', () => setOpen(false))
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setOpen(false)
  })

  // Разделы слева подсвечиваются как активные.
  menu.addEventListener('click', (event) => {
    const group = event.target.closest('.catalog-menu__group')
    if (!group) return
    for (const item of menu.querySelectorAll('.catalog-menu__group')) {
      item.setAttribute('aria-selected', String(item === group))
    }
  })
}
