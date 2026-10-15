/**
 * The live page: a brush gives runoff to grid cells, as pulses while it is held or as sources until they are erased,
 * and every river of the regions it passes over routes it live, in a worker that routes until it is stopped, while the
 * map draws their discharge a frame at a time. The regions load as the brush passes over their rivers. A river clicked
 * with the gauge tool is gauged, and loads its region: the chart draws its discharge over the last steps the worker
 * keeps, until it is clicked again or removed. Stopping ends the worker and forgets all it routed; play, the brush, or
 * a gauge starts another from nothing. The data sources come from the page's address when it names them, and
 * otherwise from the dialog.
 */
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/app.css'
import './styles/live.css'
import { createGaugeChart, GAUGE_COLORS } from './gauge-chart.js'
import { createGrid, createLiveMap } from './live-map.js'
import { DISCHARGE_CLASSES, dischargeGradient, readReach, streamsUrl } from './map.js'
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
const gauges = new Map() // each gauged river's id and its color, in the order gauged
const updates = [] // the timings of each map update of the last TIMING_SECONDS, when each reached the screen
const gaugeChart = createGaugeChart($('gauge-chart'), $('gauge-list'), removeGauge)
let grid // the runoff grid the brush paints
let liveMap
let worker // the live worker routing, or undefined while the routing is stopped

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
    giveWork({ kind: 'pulse', underBrush: nowUnderBrush, passedOver, depthMillimeters: depth })
  } else {
    for (const cellKey of cellKeys) {
      if (depth > 0) sources.set(cellKey, depth)
      else sources.delete(cellKey)
    }
    liveMap.showPainted(sources)
    $('source-cells').textContent = COUNT.format(sources.size)
    giveWork({ kind: 'runoff', cellKeys: Int32Array.from(cellKeys), depthMillimeters: depth })
  }
  requestRegions(regions)
}

/** Load each of ``regions`` that is not loaded or loading. */
function requestRegions(regions) {
  const { routingParameters, gridWeights } = readSources()
  for (const region of regions.filter(id => !requestedRegions.has(id))) {
    requestedRegions.add(region)
    giveWork({
      kind: 'region',
      id: region,
      routingParametersUrl: absoluteUrl(routingParameters.replaceAll('{region}', region)),
      gridWeightsUrl: absoluteUrl(gridWeights.replaceAll('{region}', region)),
    })
  }
}

/** Gauge the river a click of the gauge tool found, loading its region, or stop gauging it if it is gauged. */
function toggleGauge(properties) {
  const { riverId, region } = readReach(properties)
  if (gauges.has(riverId)) {
    removeGauge(riverId)
    return
  }
  const color = GAUGE_COLORS.find(unused => ![...gauges.values()].includes(unused))
  if (color === undefined) {
    showError(`at most ${GAUGE_COLORS.length} rivers can be gauged at once`)
    return
  }
  gauges.set(riverId, color)
  showGauges()
  requestRegions([region])
}

function removeGauge(riverId) {
  gauges.delete(riverId)
  showGauges()
}

/** Hand the gauges to the worker, the map, and the chart, and show the chart while there are any. */
function showGauges() {
  const gauged = Array.from(gauges, ([riverId, color]) => ({ riverId, color }))
  worker?.postMessage({ kind: 'gauges', riverIds: Int32Array.from(gauges.keys()) })
  liveMap?.setGauges(gauged)
  gaugeChart.setGauges(gauged)
  $('gauged').hidden = gauges.size === 0
}

/** Draw each gauge's history a frame holds, ``riverIds`` and a row of ``history`` each. */
function drawGauges({ riverIds, history }) {
  const nSteps = riverIds.length === 0 ? 0 : history.length / riverIds.length
  gaugeChart.draw(Array.from(riverIds, (riverId, gauge) => ({
    riverId, color: gauges.get(riverId), discharge: history.subarray(gauge * nSteps, (gauge + 1) * nSteps),
  })))
}

/** Hand the live worker work, first starting one that routes from nothing when the routing is stopped. */
function giveWork(message) {
  if (worker === undefined) startRouting()
  worker.postMessage(message)
}

/** Start a live worker routing from nothing, playing, with the gauges and the speed of the page. */
function startRouting() {
  if (grid === undefined) throw new Error('the routing starts once the runoff grid has loaded')
  if (worker !== undefined) throw new Error('the routing has started already')
  const started = new Worker(new URL('./live-worker.js', import.meta.url), { type: 'module' })
  // a stopped worker's last answers may still arrive, and are dropped
  started.onmessage = ({ data }) => {
    if (started === worker) takeAnswer(data)
  }
  started.onerror = event => {
    if (started === worker) showError(`the live worker failed: ${event.message || 'it did not load'}`)
  }
  worker = started
  worker.postMessage({ kind: 'start', nX: grid.nX, classes: DISCHARGE_CLASSES })
  worker.postMessage({ kind: 'rate', rate: $('rate').valueAsNumber * HOURS_A_SECOND_AT_1X })
  if (gauges.size > 0) worker.postMessage({ kind: 'gauges', riverIds: Int32Array.from(gauges.keys()) })
  showPlaying(true)
  $('btn-stop').disabled = false
}

/** End the live worker, and forget everything it routed: the sources, the regions, and the gauges. */
function stopRouting() {
  worker?.terminate()
  worker = undefined
  sources.clear()
  requestedRegions.clear()
  gauges.clear()
  updates.length = 0
  liveMap?.showPainted(sources)
  liveMap?.clearNetwork()
  showGauges()
  $('hours-routed').textContent = '0'
  $('source-cells').textContent = '0'
  $('regions-loaded').textContent = '—'
  $('rivers-routed').textContent = '0'
  showPlaying(false)
  $('btn-stop').disabled = true
  showError(undefined)
}

function showPlaying(playing) {
  $('btn-play').textContent = playing ? '❚❚' : '▶'
  $('btn-play').setAttribute('aria-label', playing ? 'Pause' : 'Play')
}

/** Take up an answer of the live worker: a network, a frame, or an error. */
function takeAnswer(data) {
  if (data.kind === 'network') {
    liveMap.setNetwork(data.riverIds, data.regions.map(region => region.id))
    $('regions-loaded').textContent = data.regions.map(region => region.id).join(', ')
    $('rivers-routed').textContent = COUNT.format(data.riverIds.length)
  } else if (data.kind === 'frame') {
    const handOffMs = performance.timeOrigin + performance.now() - data.timings.sentAt
    const drawStarted = performance.now()
    try {
      const nRedrawn = liveMap.drawDischarge(data.classes)
      drawGauges(data.gauges)
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

try {
  grid = createGrid(await readGridCoordinates(absoluteUrl(readSources().grid)))
  liveMap = await createLiveMap('map', absoluteUrl(streamsUrl(readSources())), grid, {
    onStroke: stroke,
    onGaugeClicked(properties) {
      try {
        toggleGauge(properties)
      } catch (error) {
        showError(error.message)
      }
    },
    onError: error => showError(error.message),
  })
  startRouting()
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

// the tools, the brush's and the gauges', of which one is in use
for (const button of document.querySelectorAll('[data-tool]')) {
  button.addEventListener('click', () => {
    for (const other of document.querySelectorAll('[data-tool]')) {
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
  worker?.postMessage({ kind: 'rate', rate: speed * HOURS_A_SECOND_AT_1X })
})
// play starts the routing again once it is stopped, and otherwise plays or pauses it
$('btn-play').addEventListener('click', () => {
  try {
    if (worker === undefined) {
      startRouting()
      return
    }
    const playing = $('btn-play').getAttribute('aria-label') === 'Pause'
    worker.postMessage({ kind: playing ? 'pause' : 'play' })
    showPlaying(!playing)
  } catch (error) {
    showError(error.message)
  }
})
$('btn-stop').addEventListener('click', stopRouting)

// the header's reset erases every source, stops every pulse, empties every river, and forgets each gauge's history,
// and keeps the regions loaded and the gauges
$('btn-reset').addEventListener('click', () => {
  sources.clear()
  liveMap?.showPainted(sources)
  $('source-cells').textContent = '0'
  worker?.postMessage({ kind: 'clear' })
  worker?.postMessage({ kind: 'drain' })
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
