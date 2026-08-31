const host = () => document.getElementById('toasts')

export function toast(message, kind = 'info') {
  const node = document.createElement('div')
  node.className = 'toast'
  node.dataset.kind = kind
  node.textContent = message
  host()?.append(node)
  setTimeout(() => node.remove(), 4000)
}
