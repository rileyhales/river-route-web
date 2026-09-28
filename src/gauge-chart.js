/**
 * The gauges' chart: each gauged river's discharge over the steps its history keeps, a line of its gauge's color, the
 * newest step at the right edge, so that a flood wave passes across it from right to left and out. Discharge is
 * labeled; time is not. A list under it names each gauge, reads out its newest discharge, and removes it.
 */
import { dischargeTicks, drawDischargeAxis, formatDischarge, svgElement } from './hydrograph.js'

/** Each gauge's color, taken in order by the first gauge without one: validated apart on the dark panel. */
export const GAUGE_COLORS = ['#d95926', '#199e70', '#c98500', '#d55181', '#9085e9', '#e66767']
const MARGIN = { top: 28, right: 12, bottom: 8, left: 56 }
const PLOT_HEIGHT = 180

/**
 * A chart in ``figure`` and a list of its gauges in ``list``, whose remove buttons hand their river id to
 * ``onRemove``, redrawn to fit whenever the figure resizes.
 */
export function createGaugeChart(figure, list, onRemove) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('aria-label', 'Discharge at each gauge')
  figure.append(svg)
  let series = [] // each gauge's riverId, color, and discharge, oldest to newest
  let readOuts = new Map() // each gauge's river id and the cell reading out its newest discharge
  const redraw = () => drawChart(svg, series, Math.floor(svg.getBoundingClientRect().width))
  new ResizeObserver(redraw).observe(figure)
  list.addEventListener('click', event => {
    const button = event.target.closest('[data-river]')
    if (button !== null) onRemove(Number(button.dataset.river))
  })
  return {
    /** List ``gauges``, a ``riverId`` and a ``color`` each, in order. */
    setGauges(gauges) {
      readOuts = new Map(gauges.map(({ riverId }) => [riverId, document.createElement('td')]))
      list.replaceChildren(...gauges.map(({ riverId, color }) => gaugeRow(riverId, color, readOuts.get(riverId))))
      series = series.filter(({ riverId }) => readOuts.has(riverId))
      redraw()
    },
    /** Draw ``next``, a ``riverId``, ``color``, and ``discharge``, oldest to newest, a gauge, of the gauges listed. */
    draw(next) {
      series = next.filter(({ riverId }) => readOuts.has(riverId))
      for (const { riverId, discharge } of series) {
        const newest = discharge[discharge.length - 1]
        readOuts.get(riverId).textContent = Number.isFinite(newest) ? formatDischarge(newest) : '—'
      }
      redraw()
    },
  }
}

/** A row of the list: the gauge's color and river id, the cell reading out its discharge, and its remove button. */
function gaugeRow(riverId, color, readOut) {
  const row = document.createElement('tr')
  const name = Object.assign(document.createElement('td'), { className: 'k' })
  const swatch = Object.assign(document.createElement('span'), { className: 'swatch' })
  swatch.style.background = color
  name.append(swatch, String(riverId))
  readOut.className = 'v'
  readOut.textContent = '—'
  const remove = Object.assign(document.createElement('button'), { className: 'btn sm', type: 'button' })
  remove.textContent = '✕'
  remove.setAttribute('aria-label', `Remove the gauge of river ${riverId}`)
  remove.dataset.river = String(riverId)
  const removeCell = document.createElement('td')
  removeCell.append(remove)
  row.append(name, readOut, removeCell)
  return row
}

/** Draw the discharge axis, from zero to above the highest discharge kept, and each gauge's line over it. */
function drawChart(svg, series, width) {
  svg.replaceChildren()
  const height = MARGIN.top + PLOT_HEIGHT + MARGIN.bottom
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.setAttribute('height', height)
  const plotWidth = Math.max(width - MARGIN.left - MARGIN.right, 1)
  const nSteps = Math.max(...series.map(({ discharge }) => discharge.length), 2)
  const highest = Math.max(0, ...series.map(({ discharge }) => highestOf(discharge)))
  const { top, ticks } = dischargeTicks(highest)
  const x = step => MARGIN.left + (step / (nSteps - 1)) * plotWidth
  const y = value => MARGIN.top + PLOT_HEIGHT * (1 - value / top)
  drawDischargeAxis(svg, ticks, y, width, MARGIN)
  for (const { color, discharge } of series) {
    const path = linePath(discharge, x, y)
    const line = { d: path, fill: 'none', stroke: color, 'stroke-width': 2 }
    if (path !== '') svgElement(svg, 'path', { ...line, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' })
    const newest = discharge.length - 1
    if (Number.isFinite(discharge[newest])) {
      const dot = { cx: x(newest), cy: y(discharge[newest]), r: 4, fill: color }
      svgElement(svg, 'circle', { ...dot, stroke: 'var(--surface)', 'stroke-width': 2 })
    }
  }
}

/** The highest finite value of ``values``, or 0 when none is. */
function highestOf(values) {
  let highest = 0
  for (const value of values) if (value > highest) highest = value
  return highest
}

/** The path through ``discharge``, broken wherever a step holds none, NaN, as before a gauge's first. */
function linePath(discharge, x, y) {
  let path = ''
  let drawing = false
  for (let step = 0; step < discharge.length; step++) {
    if (!Number.isFinite(discharge[step])) {
      drawing = false
      continue
    }
    path += `${drawing ? 'L' : 'M'}${x(step).toFixed(1)},${y(discharge[step]).toFixed(1)}`
    drawing = true
  }
  return path
}
