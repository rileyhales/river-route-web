/**
 * The live page: a brush gives runoff to grid cells, as pulses while it is held or as sources until they are erased,
 * and every river of the regions it passes over routes it live, in a worker that never stops, while the map draws their
 * discharge a frame at a time. The regions load as the brush passes over their rivers. The data sources come from the
 * page's address when it names them, and otherwise from the dialog.
 */
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/app.css'
import './styles/live.css'
import { createGrid, createLiveMap } from './live-map.js'
import { DISCHARGE_CLASSES, dischargeGradient, streamsUrl } from './map.js'
import { readGridCoordinates } from './runoff.js'

const COUNT = new Intl.NumberFormat('en-US')
const HOURS_A_SECOND_AT_1X = 24 // the simulation's hours a second at a speed of 1×
const MILLIMETERS_AN_INCH = 25.4
const TIMING_SECONDS = 1 // the map updates the timings average, those of this last many seconds
const TIMING_SHOWN_EVERY = 250 // milliseconds, how often the timings shown are updated, slowly enough to be read
// each stage of a map update, the row it is shown in, and what it is timed as
const TIMED_STAGES = {
  queue: 'queueMs', route: 'routeMs', classes: 'classesMs', 'hand-off': 'handOffMs', draw: 'drawMs',
  'to-screen': 'toScreenMs',
}
const $ = id => document.getElementById(id)

const sourcesForm = $('sources-form')
for (const [name, value] of new URLSearchParams(location.search)) {
  const field = sourcesForm.elements.namedItem(name)
  if (field !== null) field.value = value
}
const sources = new Map() // each source cell's key and runoff depth an hour, in millimeters
const requestedRegions = new Set() // the regions asked of the worker, loaded or loading
const updates = [] // the timings of each map update of the last TIMING_SECONDS, when each reached the screen
const worker = new Worker(new URL('./live-worker.js', import.meta.url), { type: 'module' })
let liveMap

function readSources() {
  return Object.fromEntries(new FormData(sourcesForm))
}

function absoluteUrl(url) {
  return new URL(url.trim(), location.href).href
}

function showError(message) {
  $('error').hidden = message === undefined
  $('error').textContent = message ?? ''
}

/**
 * Give a stroke's runoff, a pulse to the cells under the brush and those it passed over, or sources to the cells it
 * passed over, or none to erase them, and load the regions of the rivers it passed over that are not loaded.
 */
function stroke({ tool, cellKeys, underBrush, regions }) {
  const depth = tool === 'erase' ? 0 : $('brush-depth').valueAsNumber
  if (!(depth >= 0 && depth <= 250)) {
    showError('the intensity is from 0 to 250 mm/hr')
    return
  }
  if (tool === 'pulse') {
    const [nowUnderBrush, passedOver] = [Int32Array.from(underBrush), Int32Array.from(cellKeys)]
    worker.postMessage({ kind: 'pulse', underBrush: nowUnderBrush, passedOver, depthMillimeters: depth })
  } else {
    for (const cellKey of cellKeys) {
      if (depth > 0) sources.set(cellKey, depth)
      else sources.delete(cellKey)
    }
    liveMap.showPainted(sources)
    $('source-cells').textContent = COUNT.format(sources.size)
    worker.postMessage({ kind: 'runoff', cellKeys: Int32Array.from(cellKeys), depthMillimeters: depth })
  }
  const { routingParameters, gridWeights } = readSources()
  for (const region of regions.filter(id => !requestedRegions.has(id))) {
    requestedRegions.add(region)
    worker.postMessage({
      kind: 'region',
      id: region,
      routingParametersUrl: absoluteUrl(routingParameters.replaceAll('{region}', region)),
      gridWeightsUrl: absoluteUrl(gridWeights.replaceAll('{region}', region)),
    })
  }
}

worker.onmessage = ({ data }) => {
  if (data.kind === 'network') {
    liveMap.setNetwork(data.riverIds, data.regions.map(region => region.id))
    $('regions-loaded').textContent = data.regions.map(region => region.id).join(', ')
    $('rivers-routed').textContent = COUNT.format(data.riverIds.length)
  } else if (data.kind === 'frame') {
    const handOffMs = performance.timeOrigin + performance.now() - data.timings.sentAt
    const drawStarted = performance.now()
    try {
      const nRedrawn = liveMap.drawDischarge(data.classes)
      $('hours-routed').textContent = COUNT.format(data.stepsRouted)
      const drawn = performance.now()
      const update = { ...data.timings, handOffMs, drawMs: drawn - drawStarted }
      // with nothing redrawn, the map has nothing new to draw, and may not draw again for a while
      if (nRedrawn === 0) updates.push({ ...update, toScreenMs: 0, at: drawn })
      else liveMap.afterRender(() => updates.push({ ...update, toScreenMs: performance.now() - drawn, at: drawn }))
    } catch (error) {
      showError(error.message)
    } finally {
      worker.postMessage({ kind: 'frame', classes: data.classes }, [data.classes.buffer]) // for the next frame
    }
  } else if (data.kind === 'error') {
    if (data.id !== undefined) requestedRegions.delete(data.id) // so that the brush asks for it again
    showError(data.message)
  }
}
worker.onerror = event => showError(`the live worker failed: ${event.message || 'it did not load'}`)

try {
  const grid = createGrid(await readGridCoordinates(absoluteUrl(readSources().grid)))
  liveMap = await createLiveMap('map', absoluteUrl(streamsUrl(readSources())), grid, {
    onStroke: stroke,
    onError: error => showError(error.message),
  })
  worker.postMessage({ kind: 'start', nX: grid.nX, classes: DISCHARGE_CLASSES })
  worker.postMessage({ kind: 'rate', rate: $('rate').valueAsNumber * HOURS_A_SECOND_AT_1X })
} catch (error) {
  showError(error.message)
}
$('legend-ramp').style.background = dischargeGradient()

/**
 * Show the map updates of the last TIMING_SECONDS: how many a second, the mean milliseconds of each stage of one, from
 * the worker taking up the queue to the map drawing it on the screen, and their sum.
 */
function showTimings() {
  const since = performance.now() - TIMING_SECONDS * 1000
  while (updates.length > 0 && updates[0].at < since) updates.shift()
  if (updates.length === 0) {
    for (const id of ['updates', ...Object.keys(TIMED_STAGES), 'total']) $(`timing-${id}`).textContent = '—'
    return
  }
  const mean = key => updates.reduce((sum, update) => sum + update[key], 0) / updates.length
  const milliseconds = value => `${value.toFixed(2)} ms`
  $('timing-updates').textContent = COUNT.format(updates.length / TIMING_SECONDS)
  let total = 0
  for (const [id, key] of Object.entries(TIMED_STAGES)) {
    total += mean(key)
    $(`timing-${id}`).textContent = milliseconds(mean(key))
  }
  $('timing-route').textContent += ` for ${mean('hours').toFixed(1)} h`
  $('timing-total').textContent = milliseconds(total)
}
setInterval(showTimings, TIMING_SHOWN_EVERY)

for (const button of document.querySelectorAll('#tools [data-tool]')) {
  button.addEventListener('click', () => {
    for (const other of document.querySelectorAll('#tools [data-tool]')) {
      other.classList.toggle('active', other === button)
      other.setAttribute('aria-pressed', String(other === button))
    }
    liveMap?.setTool(button.dataset.tool)
  })
}
$('show-grid').addEventListener('change', () => liveMap?.setGridShown($('show-grid').checked))
$('brush-depth').addEventListener('input', () => {
  const depth = $('brush-depth').valueAsNumber
  $('brush-depth-value').textContent = `${depth} mm/hr ≈ ${(depth / MILLIMETERS_AN_INCH).toFixed(2)} in/hr`
})
$('brush-radius').addEventListener('input', () => {
  const radius = $('brush-radius').valueAsNumber
  $('brush-radius-value').textContent = `${radius} px`
  liveMap?.setBrushRadius(radius)
})
$('rate').addEventListener('input', () => {
  const speed = $('rate').valueAsNumber
  $('rate-value').textContent = `${speed}× = ${speed * HOURS_A_SECOND_AT_1X}h/s`
  worker.postMessage({ kind: 'rate', rate: speed * HOURS_A_SECOND_AT_1X })
})
$('btn-play').addEventListener('click', () => {
  const playing = $('btn-play').getAttribute('aria-label') === 'Pause'
  worker.postMessage({ kind: playing ? 'pause' : 'play' })
  $('btn-play').textContent = playing ? '▶' : '❚❚'
  $('btn-play').setAttribute('aria-label', playing ? 'Play' : 'Pause')
})

// the header's reset erases every source, stops every pulse, and empties every river, and keeps the regions loaded
$('btn-reset').addEventListener('click', () => {
  sources.clear()
  liveMap?.showPainted(sources)
  $('source-cells').textContent = '0'
  worker.postMessage({ kind: 'clear' })
  worker.postMessage({ kind: 'drain' })
  showError(undefined)
})

// the data sources dialog: opened by the header's cog, closed by its ✕, a click beside it, or Escape. A new grid or
// streams starts the page over from an address naming every source.
$('btn-sources').addEventListener('click', () => $('sources-modal').classList.remove('hidden'))
$('sources-modal').addEventListener('click', event => {
  if (event.target === event.currentTarget || event.target.closest('[data-close]') !== null) {
    event.currentTarget.classList.add('hidden')
  }
})
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') $('sources-modal').classList.add('hidden')
})
sourcesForm.addEventListener('submit', event => event.preventDefault())
sourcesForm.addEventListener('change', event => {
  if (['grid', 'streams', 'streamsArchive'].includes(event.target.name)) {
    location.search = new URLSearchParams(readSources()).toString()
  }
})
