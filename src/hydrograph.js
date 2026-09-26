/**
 * A hydrograph drawn as an SVG line chart: discharge against time with the peak labeled, and a crosshair that reads out
 * the discharge at the step under the pointer or moved with the arrow keys. The CSV download holds every value.
 */
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const MARGIN = { top: 28, right: 16, bottom: 28, left: 64 }
const PLOT_HEIGHT = 320
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_PER_TICK = [1, 2, 3, 6, 12, 24, 60, 120]
const STEPS_MOVED_BY_KEY = new Map([['ArrowLeft', -1], ['ArrowRight', 1], ['Home', -Infinity], ['End', Infinity]])
const WHOLE_NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const THREE_DIGITS = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3 })

/** Discharge rounded to show: whole cubic meters per second from 100 up, and three significant digits below. */
const formatNumber = value => (Math.abs(value) >= 100 ? WHOLE_NUMBER : THREE_DIGITS).format(value)
const formatDischarge = value => `${formatNumber(value)} m³/s`

/** A chart in ``figure`` that draws each hydrograph it is given, redrawn to fit whenever the figure resizes. */
export function createHydrographChart(figure) {
  const caption = figure.querySelector('figcaption span')
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg')
  svg.setAttribute('tabindex', '0')
  const tooltip = Object.assign(document.createElement('div'), { className: 'tooltip', hidden: true })
  figure.append(svg, tooltip)
  let hydrograph
  let chart
  let focusedStep = 0
  const redraw = () => {
    if (hydrograph !== undefined) chart = drawChart(svg, hydrograph, Math.floor(svg.getBoundingClientRect().width))
  }
  new ResizeObserver(redraw).observe(figure)
  const readOut = step => showStep(chart, hydrograph, figure, tooltip, step)
  const hideReadOut = () => {
    chart?.crosshair.setAttribute('visibility', 'hidden')
    tooltip.hidden = true
  }
  svg.addEventListener('pointermove', event => {
    if (chart !== undefined) readOut(chart.stepAt(event.clientX - svg.getBoundingClientRect().left))
  })
  svg.addEventListener('pointerleave', hideReadOut)
  svg.addEventListener('blur', hideReadOut)
  svg.addEventListener('keydown', event => {
    const move = STEPS_MOVED_BY_KEY.get(event.key)
    if (chart === undefined || move === undefined) return
    event.preventDefault()
    const last = hydrograph.discharge.length - 1
    focusedStep = Math.min(Math.max(focusedStep + move * (event.shiftKey ? 24 : 1), 0), last)
    readOut(focusedStep)
  })
  figure.querySelector('figcaption button').addEventListener('click', () => downloadCsv(hydrograph))
  return {
    draw(next) {
      hydrograph = next
      focusedStep = 0
      caption.textContent = `Discharge of river ${next.riverId}`
      svg.setAttribute('aria-label', `Hydrograph of river ${next.riverId}`)
      figure.hidden = false
      tooltip.hidden = true
      redraw()
    },
  }
}

function svgElement(parent, name, attributes, text) {
  const element = document.createElementNS(SVG_NAMESPACE, name)
  for (const [attribute, value] of Object.entries(attributes)) element.setAttribute(attribute, value)
  if (text !== undefined) element.textContent = text
  parent.append(element)
  return element
}

/** Draw the axes, the series, and the peak, and return the scales and the hidden crosshair the read out moves. */
function drawChart(svg, { times, discharge }, width) {
  svg.replaceChildren()
  const height = MARGIN.top + PLOT_HEIGHT + MARGIN.bottom
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.setAttribute('height', height)
  const plotWidth = Math.max(width - MARGIN.left - MARGIN.right, 1)
  const last = discharge.length - 1
  const peakStep = discharge.reduce((best, value, step) => (value > discharge[best] ? step : best), 0)
  const { top, ticks } = dischargeTicks(discharge[peakStep])
  const x = step => MARGIN.left + (last > 0 ? step / last : 0) * plotWidth
  const y = value => MARGIN.top + PLOT_HEIGHT * (1 - value / top)
  const xOfTime = time => x((time - times[0]) / (times[1] - times[0]))
  drawDischargeAxis(svg, ticks, y, width)
  drawTimeAxis(svg, monthTicks(times[0], times[last]), xOfTime)
  const points = Array.from(discharge, (value, step) => `${x(step).toFixed(1)},${y(value).toFixed(1)}`).join('L')
  const area = `M${x(0)},${y(0)}L${points}L${x(last)},${y(0)}Z`
  svgElement(svg, 'path', { d: area, fill: 'var(--series)', 'fill-opacity': 0.1 })
  const line = { d: `M${points}`, fill: 'none', stroke: 'var(--series)', 'stroke-width': 2 }
  svgElement(svg, 'path', { ...line, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' })
  drawPeak(svg, x(peakStep), y(discharge[peakStep]), discharge[peakStep], width)
  const crosshair = svgElement(svg, 'g', { visibility: 'hidden' })
  svgElement(crosshair, 'line', { y1: MARGIN.top, y2: MARGIN.top + PLOT_HEIGHT, stroke: 'var(--ink-muted)' })
  svgElement(crosshair, 'circle', { r: 4, fill: 'var(--series)', stroke: 'var(--surface)', 'stroke-width': 2 })
  const stepAt = pixel => Math.min(Math.max(Math.round(((pixel - MARGIN.left) / plotWidth) * last), 0), last)
  return { x, y, stepAt, crosshair }
}

/** Round discharge ticks from zero to the first tick at or above the peak, about five of them. */
function dischargeTicks(peak) {
  const rough = (peak > 0 ? peak : 1) / 5
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 2.5, 5, 10].find(multiple => multiple * magnitude >= rough) * magnitude
  const top = Math.ceil((peak > 0 ? peak : 1) / step) * step
  return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, tick) => tick * step) }
}

function drawDischargeAxis(svg, ticks, y, width) {
  const labelStyle = { fill: 'var(--ink-muted)', 'font-size': 12, 'text-anchor': 'end' }
  for (const tick of ticks) {
    const color = tick === 0 ? 'var(--baseline)' : 'var(--gridline)'
    svgElement(svg, 'line', { x1: MARGIN.left, x2: width - MARGIN.right, y1: y(tick), y2: y(tick), stroke: color })
    const label = { ...labelStyle, x: MARGIN.left - 8, y: y(tick), 'dominant-baseline': 'middle' }
    svgElement(svg, 'text', label, formatNumber(tick))
  }
  svgElement(svg, 'text', { ...labelStyle, x: MARGIN.left - 8, y: MARGIN.top - 14 }, 'm³/s')
}

/** Month starts from first to last, in seconds since 1970, every month or every few months to keep about 12. */
function monthTicks(first, last) {
  const [start, end] = [new Date(first * 1000), new Date(last * 1000)]
  const firstMonth = start.getUTCFullYear() * 12 + start.getUTCMonth()
  const nMonths = end.getUTCFullYear() * 12 + end.getUTCMonth() - firstMonth + 1
  const monthsPerTick = MONTHS_PER_TICK.find(months => nMonths / months <= 12) ?? 120
  const ticks = []
  for (let month = firstMonth; month < firstMonth + nMonths; month += monthsPerTick) {
    const year = Math.floor(month / 12)
    const time = Date.UTC(year, month % 12, 1) / 1000
    if (time >= first) ticks.push({ time, year, month: month % 12 })
  }
  return ticks
}

function drawTimeAxis(svg, ticks, xOfTime) {
  const bottom = MARGIN.top + PLOT_HEIGHT
  ticks.forEach(({ time, year, month }, index) => {
    const x = xOfTime(time)
    svgElement(svg, 'line', { x1: x, x2: x, y1: bottom, y2: bottom + 4, stroke: 'var(--baseline)' })
    const label = month === 0 || index === 0 ? `${MONTH_NAMES[month]} ${year}` : MONTH_NAMES[month]
    const position = { x, y: bottom + 18, 'text-anchor': 'middle', fill: 'var(--ink-muted)', 'font-size': 12 }
    svgElement(svg, 'text', position, label)
  })
}

/** Mark the peak with a ringed dot and label its discharge, anchored to stay inside the chart. */
function drawPeak(svg, x, y, peak, width) {
  svgElement(svg, 'circle', { cx: x, cy: y, r: 4, fill: 'var(--series)', stroke: 'var(--surface)', 'stroke-width': 2 })
  const anchor = x < width * 0.2 ? 'start' : x > width * 0.8 ? 'end' : 'middle'
  const label = { x, y: y - 10, 'text-anchor': anchor, fill: 'var(--ink-secondary)', 'font-size': 12 }
  svgElement(svg, 'text', label, `Peak ${formatDischarge(peak)}`)
}

/**
 * Move the crosshair to ``step`` and show its discharge and time in the tooltip beside it. The tooltip is placed within
 * the figure, measured from the page boxes since an svg element has no offsetLeft or offsetTop.
 */
function showStep(chart, { times, discharge }, figure, tooltip, step) {
  const [x, y] = [chart.x(step), chart.y(discharge[step])]
  chart.crosshair.setAttribute('visibility', 'visible')
  chart.crosshair.querySelector('line').setAttribute('transform', `translate(${x} 0)`)
  chart.crosshair.querySelector('circle').setAttribute('transform', `translate(${x} ${y})`)
  const value = Object.assign(document.createElement('strong'), { textContent: formatDischarge(discharge[step]) })
  const time = Object.assign(document.createElement('span'), { textContent: formatTime(times[step]) })
  tooltip.replaceChildren(value, time)
  tooltip.hidden = false
  const [svgBox, figureBox] = [chart.crosshair.ownerSVGElement.getBoundingClientRect(), figure.getBoundingClientRect()]
  const left = svgBox.left - figureBox.left - figure.clientLeft + x
  const flip = x + tooltip.offsetWidth + 24 > svgBox.width
  tooltip.style.left = `${flip ? left - tooltip.offsetWidth - 12 : left + 12}px`
  tooltip.style.top = `${svgBox.top - figureBox.top - figure.clientTop + MARGIN.top}px`
}

function formatTime(seconds) {
  return `${new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`
}

function downloadCsv({ riverId, times, discharge }) {
  const rows = Array.from(discharge, (value, step) => {
    return `${new Date(times[step] * 1000).toISOString().slice(0, 19)}Z,${value}`
  })
  const csv = new Blob([`time,discharge_m3_per_s\n${rows.join('\n')}\n`], { type: 'text/csv' })
  const url = URL.createObjectURL(csv)
  Object.assign(document.createElement('a'), { href: url, download: `discharge_${riverId}.csv` }).click()
  setTimeout(() => URL.revokeObjectURL(url)) // revoked once the download has started, which the click only queues
}
