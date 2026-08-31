/**
 * (3) Переключатель валют. По ТЗ пересчёт суммы не нужен — меняется только
 * активное состояние, поэтому здесь ровно это и происходит.
 */
export function initCurrency(root) {
  root.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-currency]')
    if (!button) return
    for (const item of root.querySelectorAll('button[data-currency]')) {
      item.setAttribute('aria-pressed', String(item === button))
    }
  })
}
