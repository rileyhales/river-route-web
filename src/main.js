/**
 * The page: a click on a river of the map picks the study area, that river and every river upstream of it; the period
 * form routes it over the chosen time in a worker; and the player then routes it again step by step in this thread,
 * drawing every river's discharge on the map and marking the step on the outlet's hydrograph in the panel.
 */
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/app.css'
import { classifyDischarge } from './discharge-classes.js'
import { createHydrographChart } from './hydrograph.js'
import { createRiverMap, DISCHARGE_CLASSES, dischargeGradient, readReach, streamsUrl } from './map.js'
import { createPlayer } from './player.js'

const SECONDS_PER_DAY = 86400
const RIVER_COUNT = new Intl.NumberFormat('en-US')
const $ = id => document.getElementById(id)

const sourcesForm = $('sources-form')
const chart = createHydrographChart($('hydrograph'))
const routeWorker = new Worker(new URL('./route-worker.js', import.meta.url), { type: 'module' })
let studyArea // the reach clicked, as readReach reads it
let routing // the study area and period the worker is routing, until it answers
let classes // each routed river's discharge class at the step shown

const riverMap = await createRiverMap('map', absoluteUrl(streamsUrl(readSources())), {
  onStreamClicked(properties) {
    try {
      selectStudyArea(readReach(properties))
    } catch (error) {
      showError(error.message)
    }
  },
  onError: error => showError(error.message),
})
const player = createPlayer((step, discharge) => {
  riverMap.drawDischarge(classifyDischarge(discharge, DISCHARGE_CLASSES, classes))
  chart.markStep(step)
})
$('legend-ramp').style.background = dischargeGradient()
boundPeriod()

/**
 * The data sources form: the url of each input, where {region} stands for the study area's region, {year} for each
 * year of the period, and {streams} for the streams archive chosen, and the first and last years of runoff.
 */
function readSources() {
  const sources = Object.fromEntries(new FormData(sourcesForm))
  return { ...sources, firstYear: Number(sources.firstYear), lastYear: Number(sources.lastYear) }
}

function absoluteUrl(url) {
  return new URL(url.trim(), location.href).href
}

/** Keep the period's dates within the years of runoff the data sources name. */
function boundPeriod() {
  const { firstYear, lastYear } = readSources()
  for (const input of [$('period-start'), $('period-end')]) {
    input.min = `${firstYear}-01-01`
    input.max = `${lastYear}-12-31`
  }
}

function showError(message) {
  $('error').hidden = message === undefined
  $('error').textContent = message ?? ''
}

/** Show ``reach`` as the study area, or none when it is undefined, with nothing routed. */
function selectStudyArea(reach) {
  studyArea = reach
  riverMap.showStudyArea(reach)
  player.clear()
  $('outlet-river').textContent = reach === undefined ? '—' : String(reach.riverId)
  $('outlet-region').textContent = reach === undefined ? '—' : reach.region
  $('study-area-rivers').textContent = reach === undefined ? '—' : RIVER_COUNT.format(reach.last - reach.first + 1)
  $('outlet-discharge').hidden = true
  $('discharge-legend').hidden = true
  $('btn-route').disabled = studyArea === undefined || routing !== undefined
  showError(undefined)
}

/** The period of the form, from the start of its first day to the end of its last, in seconds since 1970. */
function readPeriod() {
  const [first, last] = [$('period-start'), $('period-end')].map(input => input.valueAsNumber / 1000)
  if (!(first <= last)) throw new Error('the period must end on or after the day it starts')
  return { start: first, stop: last + SECONDS_PER_DAY }
}

/**
 * What routeHydrograph takes to route ``reach`` over ``period``, with the data sources' templates filled in: the runoff
 * source names one zarr a year by {year}, and each year the period touches is read.
 */
function routingInputs({ riverId, region }, period, { routingParameters, gridWeights, runoff }) {
  if (!runoff.includes('{year}')) throw new Error(`the runoff source ${runoff} must name each year's zarr by {year}`)
  const fill = (template, name, value) => absoluteUrl(template.replaceAll(`{${name}}`, value))
  const [firstYear, lastYear] = [period.start, period.stop - 1].map(time => new Date(time * 1000).getUTCFullYear())
  return {
    routingParametersUrl: fill(routingParameters, 'region', region),
    gridWeightsUrl: fill(gridWeights, 'region', region),
    runoffUrls: Array.from({ length: lastYear - firstYear + 1 }, (_, year) => fill(runoff, 'year', firstYear + year)),
    period,
    riverId,
  }
}

/** Draw a route: the outlet's hydrograph in the panel, and every river's discharge on the map, played step by step. */
function showRoute({ riverId, times, discharge, riversRouted, kernel, timings, network, riverIds, runoffByCell }) {
  const milliseconds = Object.entries(timings).map(([stage, time]) => `${stage} ${Math.round(time)} ms`).join(', ')
  console.info(`river ${riverId}: routed ${riversRouted} rivers with the ${kernel} kernel; ${milliseconds}`)
  $('outlet-discharge').hidden = false
  $('discharge-legend').hidden = false
  chart.draw({ riverId, times, discharge })
  riverMap.startDischarge(riverIds)
  classes = new Float32Array(riverIds.length)
  player.load(times, network, runoffByCell)
}

$('period-form').addEventListener('submit', event => {
  event.preventDefault()
  try {
    const period = readPeriod()
    routeWorker.postMessage(routingInputs(studyArea, period, readSources()))
    routing = { studyArea, period }
    $('btn-route').disabled = true
    showError(undefined)
  } catch (error) {
    showError(error.message)
  }
})

routeWorker.onmessage = ({ data }) => {
  const routed = routing
  routing = undefined
  $('btn-route').disabled = studyArea === undefined
  if (routed?.studyArea !== studyArea) return // the study area changed while it routed
  try {
    if (data.error !== undefined) throw new Error(data.error)
    showRoute(data.routed)
  } catch (error) {
    showError(error.message)
  }
}

routeWorker.onerror = event => {
  routing = undefined
  $('btn-route').disabled = studyArea === undefined
  showError(`the routing worker failed: ${event.message || 'it did not load'}`)
}

$('btn-csv').addEventListener('click', () => chart.downloadCsv())

// the header's reset clears the study area, its route, and the map, and keeps the period and the data sources
$('btn-reset').addEventListener('click', () => selectStudyArea(undefined))

// the data sources dialog: opened by the header's cog, closed by its ✕, a click beside it, or Escape
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
  if (event.target.name === 'firstYear' || event.target.name === 'lastYear') boundPeriod()
  if (event.target.name !== 'streams' && event.target.name !== 'streamsArchive') return
  selectStudyArea(undefined)
  try {
    riverMap.setStreams(absoluteUrl(streamsUrl(readSources())))
  } catch (error) {
    showError(error.message)
  }
})
