/**
 * Gridded runoff read from a (time, y, x) zarr array over HTTP: the array's time steps, and the series of the grid
 * cells a river network needs, read chunk by chunk in this thread or in a pool of workers.
 */
import * as zarr from 'zarrita'

const CF_SECONDS_PER_UNIT = new Map([
  ['seconds', 1], ['second', 1], ['s', 1], ['minutes', 60], ['minute', 60],
  ['hours', 3600], ['hour', 3600], ['h', 3600], ['days', 86400], ['day', 86400], ['d', 86400],
])
const CF_GREGORIAN_CALENDARS = new Set(['standard', 'gregorian', 'proleptic_gregorian'])
const CF_TIME_UNITS = /^\s*(\w+)\s+since\s+(.+?)\s*$/ // such as hours since 1940-01-01 07:00:00
const CF_REFERENCE_TIME = /^(\d{1,4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?\s*(?:Z|UTC)?$/
// the depth units river-route reads, and the factor converting each to meters
const METERS_PER_DEPTH_UNIT = new Map([['m', 1], ['meters', 1], ['kg m-2', 1], ['mm', 0.001], ['millimeters', 0.001]])
const STEPS_COPIED_TOGETHER = 64 // a tile of every cell's steps copied at once keeps the chunk rows read in cache

/** Open a runoff array and read its time steps, from the coordinate array named by its first dimension. */
export async function openRunoff(arrayUrl) {
  const url = arrayUrl.replace(/\/+$/, '')
  const array = await openZarrArray(url)
  const timeName = array.dimensionNames?.[0]
  if (array.shape.length !== 3 || !timeName) {
    throw new Error(`${url} must be a (time, y, x) array with dimension names`)
  }
  if (array.dtype !== 'float32' && array.dtype !== 'float64') {
    throw new Error(`${url} holds ${array.dtype}, expected float32 or float64 runoff depths`)
  }
  const timeArray = await openZarrArray(new URL(`../${timeName}`, `${url}/`).href)
  const { data } = await zarr.get(timeArray)
  const times = epochSecondsFromCfTimes(data, timeArray.attrs, `${url}/../${timeName}`)
  if (times.length !== array.shape[0]) {
    throw new Error(`${url} has ${array.shape[0]} time steps but its ${timeName} coordinate has ${times.length}`)
  }
  const [stepSeconds, metersPerUnit] = [uniformStepSeconds(times, url), metersPerDepthUnit(array, url)]
  return { url, array, times, stepSeconds, metersPerUnit }
}

export async function openZarrArray(url) {
  return zarr.open(new zarr.FetchStore(url), { kind: 'array' })
}

/** Whole seconds since 1970 of each CF time value, such as hours since 1940-01-01 07:00:00, in a gregorian calendar. */
function epochSecondsFromCfTimes(values, { units, calendar }, url) {
  const [, unit, reference] = CF_TIME_UNITS.exec(units ?? '') ?? []
  const referenceParts = CF_REFERENCE_TIME.exec(reference ?? '')
  if (!CF_SECONDS_PER_UNIT.has(unit) || !referenceParts) {
    throw new Error(`${url} time units '${units}' are not '<seconds|minutes|hours|days> since <date>' in UTC`)
  }
  if (calendar !== undefined && !CF_GREGORIAN_CALENDARS.has(calendar)) {
    throw new Error(`${url} uses the ${calendar} calendar; only gregorian calendars are read`)
  }
  const [year, month, day, hour, minute, second] = referenceParts.slice(1).map(part => Number(part ?? 0))
  if (calendar !== 'proleptic_gregorian' && year * 10000 + month * 100 + day < 15821015) {
    throw new Error(`${url} counts time from ${reference}, before the standard calendar turns gregorian in 1582`)
  }
  const referenceTime = new Date(0) // setUTCFullYear, unlike Date.UTC, does not read years below 100 as 1900 on
  referenceTime.setUTCFullYear(year, month - 1, day)
  referenceTime.setUTCHours(hour, minute, second)
  const [epochSeconds, secondsPerUnit] = [referenceTime.getTime() / 1000, CF_SECONDS_PER_UNIT.get(unit)]
  return Float64Array.from(values, value => Math.round(epochSeconds + Number(value) * secondsPerUnit))
}

/** The one step between times, in whole seconds. Routing needs runoff at a constant step. */
function uniformStepSeconds(times, url) {
  const stepSeconds = times.length > 1 ? times[1] - times[0] : 0
  if (!(stepSeconds > 0) || !Number.isInteger(stepSeconds)) {
    throw new Error(`${url} needs at least two time steps a positive whole number of seconds apart`)
  }
  for (let step = 2; step < times.length; step++) {
    if (times[step] - times[step - 1] !== stepSeconds) {
      throw new Error(`${url} time steps are not uniform: step ${step} is not ${stepSeconds} s after the one before`)
    }
  }
  return stepSeconds
}

/** The factor converting runoff depths to meters. Depths with no units attribute are meters, as in river-route. */
function metersPerDepthUnit(array, url) {
  const units = array.attrs.units ?? 'm'
  if (!METERS_PER_DEPTH_UNIT.has(units)) {
    throw new Error(`${url} has runoff in ${units}; expected one of ${[...METERS_PER_DEPTH_UNIT.keys()].join(', ')}`)
  }
  return METERS_PER_DEPTH_UNIT.get(units)
}

/**
 * The runoff series of every cell as one C-order (cell, time) array, read chunk by chunk with ``readChunkCells``.
 * Cells must be grouped by chunk so that each chunk's cells fill consecutive rows.
 */
export async function readRunoffCells(runoff, cellY, cellX, readChunkCells) {
  const nSteps = runoff.times.length
  const runoffByCell = new Float32Array(cellY.length * nSteps)
  const chunkReads = planChunkReads(runoff, cellY, cellX)
  await Promise.all(chunkReads.map(async ({ firstCell, firstStep, task }) => {
    const series = await readChunkCells(task)
    if (series.length !== task.cellY.length * task.steps) {
      throw new Error(`chunk ${task.chunkCoords} returned ${series.length} values for ${task.cellY.length} cells`)
    }
    for (let cell = 0; cell < task.cellY.length; cell++) {
      const cellSeries = series.subarray(cell * task.steps, (cell + 1) * task.steps)
      runoffByCell.set(cellSeries, (firstCell + cell) * nSteps + firstStep)
    }
  }))
  return runoffByCell
}

/** One read per chunk and time chunk: the cells it holds, as positions within the chunk, and its steps. */
function planChunkReads(runoff, cellY, cellX) {
  const [chunkSteps, chunkHeight, chunkWidth] = runoff.array.chunks
  const nSteps = runoff.times.length
  const chunkReads = []
  let firstCell = 0
  while (firstCell < cellY.length) {
    const chunkY = Math.floor(cellY[firstCell] / chunkHeight)
    const chunkX = Math.floor(cellX[firstCell] / chunkWidth)
    let stopCell = firstCell + 1
    while (stopCell < cellY.length && Math.floor(cellY[stopCell] / chunkHeight) === chunkY
      && Math.floor(cellX[stopCell] / chunkWidth) === chunkX) {
      stopCell++
    }
    const localY = cellY.subarray(firstCell, stopCell).map(y => y - chunkY * chunkHeight)
    const localX = cellX.subarray(firstCell, stopCell).map(x => x - chunkX * chunkWidth)
    for (let firstStep = 0; firstStep < nSteps; firstStep += chunkSteps) {
      const steps = Math.min(chunkSteps, nSteps - firstStep)
      const chunkCoords = [firstStep / chunkSteps, chunkY, chunkX]
      const task = { arrayUrl: runoff.url, chunkCoords, cellY: localY, cellX: localX, steps }
      chunkReads.push({ firstCell, firstStep, task })
    }
    firstCell = stopCell
  }
  return chunkReads
}

/** Read one chunk of an open array and copy out the series of the cells a task names. */
export async function readChunkCells(array, { chunkCoords, cellY, cellX, steps }) {
  return copyCellSeriesFromChunk(await array.getChunk(chunkCoords), cellY, cellX, steps)
}

/**
 * The first ``steps`` steps of each cell's series in a decoded (time, y, x) chunk, as C-order (cell, time) float32,
 * with NaN, such as ocean cells and missing chunks, replaced by zero so that routing never sees a NaN.
 */
export function copyCellSeriesFromChunk({ data, shape, stride }, cellY, cellX, steps) {
  if (data.length !== shape[0] * shape[1] * shape[2] || steps > shape[0] || cellY.length !== cellX.length) {
    throw new Error(`a chunk of shape ${shape} cannot give ${steps} steps of ${cellY.length} cells`)
  }
  const [timeStride, yStride, xStride] = stride
  const series = new Float32Array(cellY.length * steps)
  for (let cell = 0; cell < cellY.length; cell++) {
    if (!(cellY[cell] >= 0 && cellY[cell] < shape[1] && cellX[cell] >= 0 && cellX[cell] < shape[2])) {
      throw new Error(`cell (${cellY[cell]}, ${cellX[cell]}) is outside a chunk of shape ${shape}`)
    }
  }
  for (let tileStart = 0; tileStart < steps; tileStart += STEPS_COPIED_TOGETHER) {
    const tileStop = Math.min(tileStart + STEPS_COPIED_TOGETHER, steps)
    for (let cell = 0; cell < cellY.length; cell++) {
      const source = cellY[cell] * yStride + cellX[cell] * xStride
      const destination = cell * steps
      for (let step = tileStart; step < tileStop; step++) {
        const value = data[source + step * timeStride]
        series[destination + step] = value === value ? value : 0
      }
    }
  }
  return series
}
