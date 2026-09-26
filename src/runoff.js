/**
 * Gridded runoff read over HTTP from (time, y, x) zarr arrays, one a year: the time steps of a period, and the series
 * of the grid cells a river network needs over it, read chunk by chunk in this thread or in a pool of workers.
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

/**
 * Open the runoff arrays ``arrayUrls``, one zarr a year of consecutive years on one grid, and keep the steps from
 * ``period.start`` up to but not including ``period.stop``, in seconds since 1970, or every step when there is no
 * period. Each array must hold one year and go on from the step after the one before ends, in the same step and units.
 * The runoff's ``array`` is its first array, whose grid and chunks across it every array shares.
 */
export async function openRunoff(arrayUrls, period) {
  if (!Array.isArray(arrayUrls) || arrayUrls.length === 0) throw new Error('the runoff needs at least one array url')
  const { start, stop } = period ?? { start: -Infinity, stop: Infinity }
  if (period !== undefined && !(Number.isFinite(start) && Number.isFinite(stop) && start < stop)) {
    throw new Error(`a period must start before it stops, in seconds since 1970, not from ${start} to ${stop}`)
  }
  const arrays = await Promise.all(arrayUrls.map(openRunoffArray))
  arrays.slice(1).forEach((runoff, index) => checkContinues(arrays[index], runoff))
  const kept = arrays.map(runoff => {
    const firstStep = countTimesBefore(runoff.times, start)
    return { ...runoff, firstStep, nSteps: countTimesBefore(runoff.times, stop) - firstStep }
  }).filter(runoff => runoff.nSteps > 0)
  if (kept.length === 0) {
    const [from, to] = [start, stop].map(time => new Date(time * 1000).toISOString())
    throw new Error(`${arrayUrls.join(', ')} have no runoff from ${from} up to ${to}`)
  }
  const times = new Float64Array(kept.reduce((total, runoff) => total + runoff.nSteps, 0))
  let periodStep = 0
  const parts = kept.map(({ url, array, times: arrayTimes, firstStep, nSteps }) => {
    times.set(arrayTimes.subarray(firstStep, firstStep + nSteps), periodStep)
    periodStep += nSteps
    return { url, array, firstStep, nSteps, periodStep: periodStep - nSteps } // periodStep: its first step's place
  })
  const [{ url, array, stepSeconds, metersPerUnit }] = arrays
  return { url, array, parts, times, stepSeconds, metersPerUnit }
}

/** The count of increasing ``times`` before ``time``. */
function countTimesBefore(times, time) {
  let count = 0
  while (count < times.length && times[count] < time) count++
  return count
}

/** Whether runoff array ``next`` goes on from ``before``: the same grid and chunks across it, step, and units. */
function checkContinues(before, next) {
  const [grid, nextGrid] = [before, next].map(({ array }) => [...array.shape.slice(1), ...array.chunks.slice(1)].join())
  if (grid !== nextGrid) throw new Error(`${next.url} is not on the grid and chunks of ${before.url}`)
  if (next.stepSeconds !== before.stepSeconds || next.metersPerUnit !== before.metersPerUnit) {
    throw new Error(`${next.url} does not have the time step and units of ${before.url}`)
  }
  if (next.times[0] !== before.times[before.times.length - 1] + before.stepSeconds) {
    throw new Error(`${next.url} does not start the step after ${before.url} ends`)
  }
}

/** Open one year's runoff array and read its time steps, from the coordinate array named by its first dimension. */
async function openRunoffArray(arrayUrl) {
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
  checkOneYear(times, url)
  return { url, array, times, stepSeconds, metersPerUnit }
}

/**
 * The latitude of each row and the longitude of each column of the grid a (time, y, x) runoff array lies on, from the
 * coordinate arrays named by its dimensions, beside it in the store.
 */
export async function readGridCoordinates(arrayUrl) {
  const url = arrayUrl.replace(/\/+$/, '')
  const array = await openZarrArray(url)
  const [, yName, xName] = array.dimensionNames ?? []
  if (array.shape.length !== 3 || !yName || !xName) {
    throw new Error(`${url} must be a (time, y, x) array with dimension names`)
  }
  const [latitudes, longitudes] = await Promise.all([yName, xName].map(async name => {
    const { data } = await zarr.get(await openZarrArray(new URL(`../${name}`, `${url}/`).href))
    return Float64Array.from(data, Number)
  }))
  if (latitudes.length !== array.shape[1] || longitudes.length !== array.shape[2]) {
    throw new Error(`${url} is ${array.shape[1]} by ${array.shape[2]}, but its ${yName} and ${xName} are not`)
  }
  return { latitudes, longitudes }
}

/**
 * Open the zarr array at ``url``: v3, or failing that v2. zarrita's own open looks for v2 first on a store it has not
 * opened before, and every array here gets a store of its own, so each v3 open would first ask for two files missing.
 */
export async function openZarrArray(url) {
  const store = new zarr.FetchStore(url)
  return zarr.open.v3(store, { kind: 'array' }).catch(error => {
    if (!(error instanceof zarr.NotFoundError)) throw error
    return zarr.open.v2(store, { kind: 'array' })
  })
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

/** Refuse runoff ``times``, in seconds since 1970, that reach past one calendar year: runoff comes one zarr a year. */
export function checkOneYear(times, url) {
  const [firstYear, lastYear] = [times[0], times[times.length - 1]].map(time => new Date(time * 1000).getUTCFullYear())
  if (firstYear !== lastYear) {
    throw new Error(`${url} holds runoff from ${firstYear} to ${lastYear}; runoff is read one zarr a year`)
  }
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
 * The runoff series of every cell over the period as one C-order (cell, time) array, read chunk by chunk with
 * ``readChunkCells``. Cells must be grouped by chunk so that each chunk's cells fill consecutive rows.
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

/**
 * One read per chunk of each array's time chunks the period covers: the cells it holds, as positions within the chunk,
 * the first of its steps read and how many, and where they go in the period's series.
 */
function planChunkReads(runoff, cellY, cellX) {
  const [, chunkHeight, chunkWidth] = runoff.array.chunks
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
    for (const part of runoff.parts) {
      const [chunkSteps] = part.array.chunks
      const stopStep = part.firstStep + part.nSteps
      for (let chunkStart = part.firstStep - (part.firstStep % chunkSteps); chunkStart < stopStep;
        chunkStart += chunkSteps) {
        const [from, to] = [Math.max(part.firstStep, chunkStart), Math.min(stopStep, chunkStart + chunkSteps)]
        const chunkCoords = [chunkStart / chunkSteps, chunkY, chunkX]
        const task = {
          arrayUrl: part.url, chunkCoords, cellY: localY, cellX: localX, firstStep: from - chunkStart, steps: to - from,
        }
        chunkReads.push({ firstCell, firstStep: part.periodStep + from - part.firstStep, task })
      }
    }
    firstCell = stopCell
  }
  return chunkReads
}

/** Read one chunk of an open array and copy out the series of the cells a task names. */
export async function readChunkCells(array, { chunkCoords, cellY, cellX, firstStep, steps }) {
  return copyCellSeriesFromChunk(await array.getChunk(chunkCoords), cellY, cellX, firstStep, steps)
}

/**
 * The ``steps`` steps from ``firstStep`` of each cell's series in a decoded (time, y, x) chunk, as C-order (cell, time)
 * float32, with NaN, such as ocean cells and missing chunks, replaced by zero so that routing never sees a NaN.
 */
export function copyCellSeriesFromChunk({ data, shape, stride }, cellY, cellX, firstStep, steps) {
  const stepsFit = Number.isInteger(firstStep) && firstStep >= 0 && steps >= 1 && firstStep + steps <= shape[0]
  if (data.length !== shape[0] * shape[1] * shape[2] || !stepsFit || cellY.length !== cellX.length) {
    throw new Error(`a chunk of shape ${shape} cannot give ${steps} steps from ${firstStep} of ${cellY.length} cells`)
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
        const value = data[source + (firstStep + step) * timeStride]
        series[destination + step] = value === value ? value : 0
      }
    }
  }
  return series
}
