/** The page: routes the hydrograph of the inputs in the form in a worker, and draws it. */
import { createHydrographChart } from './hydrograph.js'

const form = document.querySelector('#inputs')
const routeButton = form.querySelector('button')
const errorMessage = document.querySelector('#error')
const figure = document.querySelector('#hydrograph')
const chart = createHydrographChart(figure)
const routeWorker = new Worker(new URL('./route-worker.js', import.meta.url), { type: 'module' })

function finishRouting(error) {
  routeButton.disabled = false
  figure.setAttribute('aria-busy', 'false')
  errorMessage.hidden = error === undefined
  errorMessage.textContent = error ?? ''
}

form.addEventListener('submit', event => {
  event.preventDefault()
  try {
    const urls = [...new FormData(form)].map(([name, value]) => [name, new URL(value.trim(), location.href).href])
    routeButton.disabled = true
    figure.setAttribute('aria-busy', 'true')
    routeWorker.postMessage(Object.fromEntries(urls))
  } catch (error) {
    finishRouting(error.message)
  }
})

routeWorker.onmessage = ({ data }) => {
  finishRouting(data.error)
  if (data.error !== undefined) return
  const { riverId, riversRouted, kernel, timings } = data.routed
  const milliseconds = Object.entries(timings).map(([stage, time]) => `${stage} ${Math.round(time)} ms`).join(', ')
  console.info(`river ${riverId}: routed ${riversRouted} rivers with the ${kernel} kernel; ${milliseconds}`)
  chart.draw(data.routed)
}

routeWorker.onerror = event => finishRouting(`the routing worker failed: ${event.message || 'it did not load'}`)
