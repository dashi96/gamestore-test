/** (1) Баннер-карусель: автопрокрутка, стрелки и активные точки-индикаторы. */
export function initCarousel({ track, dots, prev, next, slides, intervalMs = 4000 }) {
  track.innerHTML = slides
    .map(
      (slide) => `
      <article class="banner__slide" style="background:${slide.background}">
        <h3>${slide.title}</h3>
        <p>${slide.text}</p>
      </article>`,
    )
    .join('')

  dots.innerHTML = slides
    .map((_, i) => `<button type="button" aria-label="Слайд ${i + 1}" data-index="${i}"></button>`)
    .join('')

  let index = 0
  let timer = null

  const render = () => {
    track.style.transform = `translateX(-${index * 100}%)`
    for (const dot of dots.children) {
      dot.setAttribute('aria-current', String(Number(dot.dataset.index) === index))
    }
  }

  const go = (next) => {
    index = (next + slides.length) % slides.length
    render()
  }

  const play = () => {
    stop()
    timer = setInterval(() => go(index + 1), intervalMs)
  }
  const stop = () => timer && clearInterval(timer)

  prev.addEventListener('click', () => {
    go(index - 1)
    play() // после ручного переключения отсчёт автопрокрутки начинается заново
  })
  next.addEventListener('click', () => {
    go(index + 1)
    play()
  })
  dots.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-index]')
    if (!button) return
    go(Number(button.dataset.index))
    play()
  })

  // Пока курсор на баннере, слайды не убегают из-под мыши.
  track.parentElement.addEventListener('mouseenter', stop)
  track.parentElement.addEventListener('mouseleave', play)
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : play()))

  render()
  play()
}
