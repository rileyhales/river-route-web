/**
 * Muskingum routing of gridded runoff to the hydrograph of one river with river-route's static coefficients and
 * uniform runoff transform, every river starting from no discharge. prepare.js settles every decision of the run, the
 * coefficients and the sub-reaches of each river, and kernel.js routes; this module reads the inputs they route.
 * The network file and grid weights are parquet files and the runoff a zarr array a year, all read over HTTP. Only the
 * chosen river and the rivers upstream of it are routed, over the chosen period.
 */
import { parquetMetadata, parquetRead, parquetSchema } from 'hyparquet'
import { kernelModule, routeRivers } from './kernel.js'
import * as kernelSetup from './prepare.js'
import { openRunoff, readChunkCells, readRunoffCells } from './runoff.js'

// seconds: every river's step, an hour, in sub-reaches or subcycles of it where its coefficients would be negative
const DT_ROUTING = 3600
const ROUTING_PARAMETER_COLUMNS = {
  riverId: Int32Array, nextRiverId: Int32Array, muskingumK: Float64Array, muskingumX: Float64Array,
}
const GRID_WEIGHT_COLUMNS = {
  riverId: Int32Array, x_index: Int32Array, y_index: Int32Array, area_sqm: Float64Array, proportion: Float64Array,
}

/**
 * Route runoff to the hydrograph of ``riverId``, or when it is undefined, of the outlet that drains the largest area.
 * Everything runs in this thread unless ``workerPool`` is given: its workers then read the runoff chunks and route the
 * jobs of sub-watershed blocks, while this thread routes the main stem the blocks drain into. What was routed comes
 * back too: the network, the id of each of its rivers, and their cells' runoff, as prepareRouting gives them, for a map
 * to route again step by step.
 */
export async function routeHydrograph(inputs, workerPool) {
  const { riverId, riverIds, times, network, runoffByCell, nSteps, timings } = await prepareRouting(inputs, workerPool)
  const started = performance.now()
  const runoff = { depth: runoffByCell, nSteps }
  const series = workerPool?.size > 1
    ? await routeJobsInParallel(network, runoff, workerPool)
    : routeRivers(network, runoff, { keep: network.outlets }) // the target, the one river draining out of them
  return {
    riverId,
    times,
    discharge: series,
    riversRouted: riverIds.length,
    kernel: kernelModule,
    timings: { ...timings, routing: performance.now() - started },
    network,
    riverIds,
    runoffByCell,
  }
}

/**
 * Read everything routing to the hydrograph of ``riverId`` needs: the network of it and the rivers upstream of it, in
 * the form kernel.js's routeRivers takes, the id of each of its rivers, and its cells' runoff over ``period``,
 * { start, stop } in seconds since 1970 with stop left out, or over every step of ``runoffUrls`` without one, each
 * cell's steps one after another as runoffByCell. Runoff is read on ``workerPool`` when it is given.
 */
export async function prepareRouting(inputs, workerPool) {
  const { routingParametersUrl, gridWeightsUrl, runoffUrls, period, riverId } = inputs
  const started = performance.now()
  const [parameters, weights, runoff] = await Promise.all([
    readRoutingParameters(routingParametersUrl),
    readParquetColumns(gridWeightsUrl, GRID_WEIGHT_COLUMNS),
    openRunoff(runoffUrls, period),
  ])
  const { riverOfWeight, catchmentAreas } = matchWeightsToRivers(parameters, weights, gridWeightsUrl)
  const target = riverId === undefined
    ? findMainOutlet(parameters.downstreamIndices, catchmentAreas)
    : findRiver(parameters, riverId, routingParametersUrl)
  const rivers = selectUpstreamRivers(parameters.downstreamIndices, target)
  const matched = { parameters, weights, riverOfWeight, catchmentAreas }
  const { network, cellY, cellX } = prepareNetwork(matched, rivers, runoff)
  const inputsRead = performance.now()
  const arrays = new Map(runoff.parts.map(part => [part.url, part.array]))
  const readChunk = workerPool === undefined
    ? task => readChunkCells(arrays.get(task.arrayUrl), task)
    : task => workerPool.run({ kind: 'readChunkCells', ...task })
  const runoffByCell = await readRunoffCells(runoff, cellY, cellX, readChunk)
  return {
    riverId: parameters.riverIds[target],
    riverIds: rivers.map(river => parameters.riverIds[river]),
    times: runoff.times,
    network,
    runoffByCell,
    nSteps: runoff.times.length,
    timings: { inputs: inputsRead - started, runoff: performance.now() - inputsRead },
  }
}

/**
 * Everything live routing needs of every river of a region, in network file order: their ids; the network kernel.js
 * routes of them at a step of ``stepSeconds``, with each river's weights, weightStarts and weights, the volume (m³) a
 * meter of runoff depth in each weight's cell gives the river, but not the cells, which a live engine numbers; and the
 * cell of each weight, as a y and an x index of the runoff grid.
 */
export async function prepareRegion({ routingParametersUrl, gridWeightsUrl }, stepSeconds) {
  const [parameters, weights] = await Promise.all([
    readRoutingParameters(routingParametersUrl),
    readParquetColumns(gridWeightsUrl, GRID_WEIGHT_COLUMNS),
  ])
  const { riverOfWeight, catchmentAreas } = matchWeightsToRivers(parameters, weights, gridWeightsUrl)
  const rivers = Int32Array.from(parameters.riverIds.keys())
  const matched = { parameters, weights, riverOfWeight, catchmentAreas }
  const { weightCells: rows, ...network } = prepareRivers(matched, rivers, stepSeconds, 1)
  return {
    riverIds: parameters.riverIds,
    network,
    weightCellY: rows.map(row => weights.y_index[row]),
    weightCellX: rows.map(row => weights.x_index[row]),
  }
}

/** The network file's columns, with each river's position by id and the position of the river it drains into. */
export async function readRoutingParameters(url) {
  const { riverId: riverIds, nextRiverId: nextRiverIds, muskingumK: k, muskingumX: x } = await readParquetColumns(
    url, ROUTING_PARAMETER_COLUMNS,
  )
  const indexOfRiver = new Map()
  for (let river = 0; river < riverIds.length; river++) {
    if (indexOfRiver.has(riverIds[river])) throw new Error(`${url} has riverId ${riverIds[river]} more than once`)
    indexOfRiver.set(riverIds[river], river)
  }
  const downstreamIndices = new Int32Array(riverIds.length)
  for (let river = 0; river < riverIds.length; river++) {
    const downstream = nextRiverIds[river] === -1 ? -1 : indexOfRiver.get(nextRiverIds[river])
    if (downstream === undefined) throw new Error(`${url} has nextRiverId ${nextRiverIds[river]}, not a riverId`)
    if (downstream !== -1 && downstream <= river) {
      throw new Error(`${url} lists river ${riverIds[river]} after ${nextRiverIds[river]}, the river it drains into`)
    }
    downstreamIndices[river] = downstream
  }
  return { riverIds, indexOfRiver, downstreamIndices, k, x }
}

/**
 * Columns of a parquet file read over HTTP into typed arrays of the given types. Missing values raise, which is checked
 * after reading because hyparquet does not surface errors thrown while it hands over a column.
 */
export async function readParquetColumns(url, typeOfColumn) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered ${response.status} ${response.statusText}`)
  const file = await response.arrayBuffer()
  const metadata = parquetMetadata(file)
  const nRows = Number(metadata.num_rows)
  const names = Object.keys(typeOfColumn)
  const present = new Set(parquetSchema(metadata).children.map(child => child.element.name))
  const absent = names.filter(name => !present.has(name))
  if (absent.length > 0) throw new Error(`${url} has no ${absent.join(', ')} column`)
  const columns = Object.fromEntries(names.map(name => [name, new typeOfColumn[name](nRows)]))
  const rowsRead = Object.fromEntries(names.map(name => [name, 0]))
  const missing = Object.fromEntries(names.map(name => [name, 0]))
  await parquetRead({
    file, metadata, columns: names, onChunk: ({ columnName, columnData, rowStart }) => {
      const column = columns[columnName]
      for (let row = 0; row < columnData.length; row++) {
        const value = columnData[row]
        if (value === null || value === undefined) missing[columnName]++
        else column[rowStart + row] = Number(value)
      }
      rowsRead[columnName] += columnData.length
    },
  })
  for (const name of names) {
    if (missing[name] > 0) throw new Error(`${url} is missing ${missing[name]} values of ${name}`)
    if (rowsRead[name] !== nRows) throw new Error(`${url} gave ${rowsRead[name]} of ${nRows} rows of ${name}`)
  }
  return columns
}

/** The routing parameters row of each weight row, and each river's catchment area, the sum of its weights' areas. */
function matchWeightsToRivers({ riverIds, indexOfRiver }, weights, url) {
  const riverOfWeight = new Int32Array(weights.riverId.length)
  const catchmentAreas = new Float64Array(riverIds.length)
  const weightsOfRiver = new Int32Array(riverIds.length)
  for (let weight = 0; weight < riverOfWeight.length; weight++) {
    const river = indexOfRiver.get(weights.riverId[weight])
    if (river === undefined) throw new Error(`${url} weighs river ${weights.riverId[weight]}, not a routed river`)
    riverOfWeight[weight] = river
    catchmentAreas[river] += weights.area_sqm[weight]
    weightsOfRiver[river]++
  }
  const unweighted = weightsOfRiver.indexOf(0)
  if (unweighted >= 0) throw new Error(`${url} has no weights for river ${riverIds[unweighted]}`)
  return { riverOfWeight, catchmentAreas }
}

/** The outlet that drains the largest area. Rivers come before the rivers they drain into, so one pass sums areas. */
function findMainOutlet(downstreamIndices, catchmentAreas) {
  const drainageAreas = Float64Array.from(catchmentAreas)
  let mainOutlet = -1
  for (let river = 0; river < downstreamIndices.length; river++) {
    const downstream = downstreamIndices[river]
    if (downstream >= 0) drainageAreas[downstream] += drainageAreas[river]
    else if (mainOutlet < 0 || drainageAreas[river] > drainageAreas[mainOutlet]) mainOutlet = river
  }
  if (mainOutlet < 0) throw new Error('the routing parameters have no outlet')
  return mainOutlet
}

function findRiver({ indexOfRiver }, riverId, url) {
  const river = indexOfRiver.get(Number(riverId))
  if (river === undefined) throw new Error(`${url} has no river ${riverId}`)
  return river
}

/**
 * The network routing reads of ``rivers``, a target and the rivers upstream of it in network file order with the
 * target last, prepareRivers's with each weight's cell its row of the runoff read, and of each cell read, its y and x
 * index in the runoff grid, as cellY and cellX.
 */
function prepareNetwork(matched, rivers, runoff) {
  const network = prepareRivers(matched, rivers, runoff.stepSeconds, runoff.metersPerUnit)
  const { y_index: weightY, x_index: weightX } = matched.weights
  const { cellOfKey, cellY, cellX } = indexRunoffCells(weightY, weightX, network.weightCells, runoff)
  const nX = runoff.array.shape[2]
  const weightCells = network.weightCells.map(row => cellOfKey.get(weightY[row] * nX + weightX[row]))
  return { network: { ...network, weightCells }, cellY, cellX }
}

/**
 * The network kernel.js routes of ``rivers``, every river or a target and the rivers upstream of it,
 * in network file order, at a step of ``stepSeconds``, as its prepareRouting gives it, with the weights of each river
 * added: weightStarts; weightCells, still the rows of the grid weights each was read from; and weights, the volume
 * (m³) a unit of runoff depth in the cell gives the river, its share of the river's catchment area times
 * ``metersPerUnit``, in float32 as river-route keeps it.
 */
function prepareRivers({ parameters, weights, riverOfWeight, catchmentAreas }, rivers, stepSeconds, metersPerUnit) {
  const positionOfRiver = new Int32Array(parameters.riverIds.length).fill(-1)
  rivers.forEach((river, position) => { positionOfRiver[river] = position })
  const downstreamIndices = rivers.map(river => {
    const downstream = parameters.downstreamIndices[river]
    return downstream < 0 ? -1 : positionOfRiver[downstream] // -1 too where the river drains out of ``rivers``
  })
  const k = Float64Array.from(rivers, river => parameters.k[river])
  const x = Float64Array.from(rivers, river => parameters.x[river])
  // a river that no sub-reaches or subcycles make valid is routed, and the console told of it
  const options = { dtRunoff: stepSeconds, dtRouting: DT_ROUTING, invalidCoefficients: 'log' }
  const network = kernelSetup.prepareRouting({ downstreamIndices, k, x }, options)
  const nRivers = rivers.length
  const weightStarts = new Int32Array(nRivers + 1)
  for (let weight = 0; weight < riverOfWeight.length; weight++) {
    const position = positionOfRiver[riverOfWeight[weight]]
    if (position >= 0) weightStarts[position + 1]++
  }
  for (let position = 0; position < nRivers; position++) weightStarts[position + 1] += weightStarts[position]
  const weightCells = new Int32Array(weightStarts[nRivers])
  const volumes = new Float32Array(weightStarts[nRivers])
  const nextWeight = weightStarts.slice(0, nRivers)
  for (let weight = 0; weight < riverOfWeight.length; weight++) {
    const river = riverOfWeight[weight]
    const position = positionOfRiver[river]
    if (position < 0) continue
    const slot = nextWeight[position]++
    weightCells[slot] = weight
    volumes[slot] = catchmentAreas[river] * weights.proportion[weight] * metersPerUnit
  }
  return { ...network, weightStarts, weightCells, weights: volumes }
}

/** The rivers that drain into ``target``, and the target last, in routing parameter order. */
function selectUpstreamRivers(downstreamIndices, target) {
  const drainsToTarget = new Uint8Array(target + 1)
  drainsToTarget[target] = 1
  let nRivers = 1
  for (let river = target - 1; river >= 0; river--) {
    const downstream = downstreamIndices[river]
    if (downstream >= 0 && downstream <= target && drainsToTarget[downstream] === 1) {
      drainsToTarget[river] = 1
      nRivers++
    }
  }
  const rivers = new Int32Array(nRivers)
  let position = 0
  for (let river = 0; river <= target; river++) {
    if (drainsToTarget[river] === 1) rivers[position++] = river
  }
  return rivers
}

/**
 * The grid cells the weights of ``rows`` of the grid weights cover, by their position in the runoff grid, sorted by
 * runoff chunk so that each chunk's cells fill consecutive rows of the runoff read.
 */
function indexRunoffCells(weightY, weightX, rows, runoff) {
  const [, nY, nX] = runoff.array.shape
  const [, chunkHeight, chunkWidth] = runoff.array.chunks
  const cellOfKey = new Map()
  for (const row of rows) {
    const [y, x] = [weightY[row], weightX[row]]
    if (!(y >= 0 && y < nY && x >= 0 && x < nX)) {
      throw new Error(`a weight's cell (y ${y}, x ${x}) is outside the ${nY} by ${nX} runoff grid of ${runoff.url}`)
    }
    cellOfKey.set(y * nX + x, -1)
  }
  const chunksPerRow = Math.ceil(nX / chunkWidth)
  const chunkOf = key => Math.floor(key / nX / chunkHeight) * chunksPerRow + Math.floor((key % nX) / chunkWidth)
  const keys = Float64Array.from(cellOfKey.keys()).sort((a, b) => chunkOf(a) - chunkOf(b) || a - b)
  const cellY = new Int32Array(keys.length)
  const cellX = new Int32Array(keys.length)
  keys.forEach((key, cell) => {
    cellOfKey.set(key, cell)
    cellY[cell] = Math.floor(key / nX)
    cellX[cell] = key % nX
  })
  return { cellOfKey, cellY, cellX }
}

/**
 * Route the jobs of sub-watershed blocks prepare.js's assignBlocks packs for the pool's workers, all at once on the
 * workers, then the main stem, the last job, in this thread from the series of the blocks' outlets. Returns the
 * target's series, the outlet of the main stem.
 */
async function routeJobsInParallel(network, runoff, workerPool) {
  const jobs = kernelSetup.assignBlocks(network, workerPool.size)
  const mainStem = jobs.pop()
  const outlets = jobs.map(blocks => blocks.stops.map(stop => stop - 1)) // each block's last river
  const outletSeries = await Promise.all(jobs.map((blocks, job) => {
    const part = extractJob(network, runoff, blocks)
    const transfer = [part.runoff.depth, part.network.weightStarts, part.network.weightCells, part.network.weights]
    const task = { kind: 'route', ...part, blocks, keep: outlets[job] }
    return workerPool.run(task, transfer.map(array => array.buffer))
  }))
  const given = { rivers: new Int32Array(outlets.reduce((count, rivers) => count + rivers.length, 0)) }
  given.series = new Float32Array(given.rivers.length * runoff.nSteps)
  outlets.reduce((first, rivers, job) => {
    given.rivers.set(rivers, first)
    given.series.set(outletSeries[job], first * runoff.nSteps)
    return first + rivers.length
  }, 0)
  return routeRivers(network, runoff, { keep: network.outlets, blocks: mainStem, given })
}

/**
 * What a worker routes the rivers of ``blocks`` from: the network with the weights of only those rivers, which read
 * the cells numbered in the order first read, and runoff of only those cells.
 */
function extractJob(network, { depth, nSteps }, { starts, stops }) {
  const nRivers = network.weightStarts.length - 1
  const inBlocks = new Uint8Array(nRivers)
  starts.forEach((start, block) => inBlocks.fill(1, start, stops[block]))
  const weightStarts = new Int32Array(nRivers + 1)
  const [weightCells, weights] = [[], []]
  const localCell = new Map() // each cell read, by its row of the runoff read, and its row of the job's runoff
  for (let river = 0; river < nRivers; river++) {
    const [first, stop] = inBlocks[river] ? [network.weightStarts[river], network.weightStarts[river + 1]] : [0, 0]
    for (let weight = first; weight < stop; weight++) {
      const cell = network.weightCells[weight]
      if (!localCell.has(cell)) localCell.set(cell, localCell.size)
      weightCells.push(localCell.get(cell))
      weights.push(network.weights[weight])
    }
    weightStarts[river + 1] = weightCells.length
  }
  const jobDepth = new Float32Array(localCell.size * nSteps)
  for (const [cell, local] of localCell) {
    jobDepth.set(depth.subarray(cell * nSteps, (cell + 1) * nSteps), local * nSteps)
  }
  const jobWeights = { weightStarts, weightCells: Int32Array.from(weightCells), weights: Float32Array.from(weights) }
  return { network: { ...network, ...jobWeights }, runoff: { depth: jobDepth, nSteps } }
}
