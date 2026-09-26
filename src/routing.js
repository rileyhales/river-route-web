/**
 * Muskingum routing of gridded runoff to the hydrograph of one river, the simplest case of river-route: static
 * coefficients, the uniform runoff transform, one reach per river, a routing step equal to the runoff step, and every
 * river starting from no discharge. The routing parameters and grid weights are parquet files and the runoff is a zarr
 * array, all read over HTTP. Only the chosen river and the rivers upstream of it are routed.
 */
import { parquetMetadata, parquetRead, parquetSchema } from 'hyparquet'
import { routeRivers } from './muskingum.js'
import { openRunoff, readChunkCells, readRunoffCells } from './runoff.js'

/**
 * Route runoff to the hydrograph of ``riverId``, or when it is undefined, of the outlet that drains the largest area.
 * Everything runs in this thread unless ``workerPool`` is given: its workers then read the runoff chunks and route the
 * regions of the network, while this thread routes the main stem the regions drain into. Even the 1,390 rivers above
 * the Willamette's mouth routed in 11 ms on 8 workers rather than 27 ms in one thread.
 */
export async function routeHydrograph({ routingParametersUrl, gridWeightsUrl, runoffUrl, riverId }, workerPool) {
  const started = performance.now()
  const [parameters, weights, runoff] = await Promise.all([
    readRoutingParameters(routingParametersUrl),
    readParquetColumns(gridWeightsUrl, GRID_WEIGHT_COLUMNS),
    openRunoff(runoffUrl),
  ])
  const { riverOfWeight, catchmentAreas } = matchWeightsToRivers(parameters, weights, gridWeightsUrl)
  const target = riverId === undefined
    ? findMainOutlet(parameters.downstreamIndices, catchmentAreas)
    : findRiver(parameters, riverId, routingParametersUrl)
  const network = prepareNetwork(parameters, weights, riverOfWeight, catchmentAreas, target, runoff)
  const nSteps = runoff.times.length
  const inputsRead = performance.now()
  const readChunk = workerPool === undefined
    ? task => readChunkCells(runoff.array, task)
    : task => workerPool.run({ kind: 'readChunkCells', ...task })
  const runoffByCell = await readRunoffCells(runoff, network.cellY, network.cellX, readChunk)
  const runoffRead = performance.now()
  const series = workerPool?.size > 1
    ? await routeRegionsInParallel(network, runoffByCell, nSteps, workerPool)
    : routeRivers(network, runoffByCell, nSteps)
  const routed = performance.now()
  return {
    riverId: parameters.riverIds[target],
    times: runoff.times,
    discharge: series.map(discharge => Math.max(discharge, 0)), // clamped as river-route writes discharge
    riversRouted: network.c1.length,
    timings: { inputs: inputsRead - started, runoff: runoffRead - inputsRead, routing: routed - runoffRead },
  }
}

const ROUTING_PARAMETER_COLUMNS = { river_id: Int32Array, next_river_id: Int32Array, k: Float64Array, x: Float64Array }
const GRID_WEIGHT_COLUMNS = {
  river_id: Int32Array, x_index: Int32Array, y_index: Int32Array, area_sqm: Float64Array, proportion: Float64Array,
}

/** The routing parameters, with each river's position by id and the position of the river it drains into. */
export async function readRoutingParameters(url) {
  const { river_id: riverIds, next_river_id: nextRiverIds, k, x } = await readParquetColumns(
    url, ROUTING_PARAMETER_COLUMNS,
  )
  const indexOfRiver = new Map()
  for (let river = 0; river < riverIds.length; river++) {
    if (indexOfRiver.has(riverIds[river])) throw new Error(`${url} has river_id ${riverIds[river]} more than once`)
    indexOfRiver.set(riverIds[river], river)
  }
  const downstreamIndices = new Int32Array(riverIds.length)
  for (let river = 0; river < riverIds.length; river++) {
    const downstream = nextRiverIds[river] === -1 ? -1 : indexOfRiver.get(nextRiverIds[river])
    if (downstream === undefined) throw new Error(`${url} has next_river_id ${nextRiverIds[river]}, not a river_id`)
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
  const riverOfWeight = new Int32Array(weights.river_id.length)
  const catchmentAreas = new Float64Array(riverIds.length)
  const weightsOfRiver = new Int32Array(riverIds.length)
  for (let weight = 0; weight < riverOfWeight.length; weight++) {
    const river = indexOfRiver.get(weights.river_id[weight])
    if (river === undefined) throw new Error(`${url} weighs river ${weights.river_id[weight]}, not a routed river`)
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
 * Everything routing reads about the rivers upstream of ``target``, in routing parameter order with the target last:
 * the position each drains into (-1 for the target), their Muskingum coefficients, the runoff cells, and the weights.
 */
function prepareNetwork(parameters, weights, riverOfWeight, catchmentAreas, target, runoff) {
  const rivers = selectUpstreamRivers(parameters.downstreamIndices, target)
  const positionOfRiver = new Int32Array(parameters.riverIds.length).fill(-1)
  rivers.forEach((river, position) => { positionOfRiver[river] = position })
  const downstreamPositions = rivers.map(river => {
    return river === target ? -1 : positionOfRiver[parameters.downstreamIndices[river]]
  })
  const coefficients = muskingumCoefficients(parameters, rivers, runoff.stepSeconds)
  const cells = indexRunoffCells(weights, riverOfWeight, positionOfRiver, runoff)
  const forcing = weighRiverCells(weights, riverOfWeight, positionOfRiver, catchmentAreas, coefficients, cells, runoff)
  return { downstreamPositions, ...coefficients, cellY: cells.cellY, cellX: cells.cellX, ...forcing }
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
 * Each river's Muskingum coefficients at the runoff step, computed in float64 as river-route computes them from its
 * int64 k and float64 x, and rounded to float32 as it stores them. c4 = (c1 + c2) / dt turns a catchment runoff
 * volume, which the uniform transform spreads evenly over the runoff step, into the river's forcing.
 */
function muskingumCoefficients({ riverIds, k, x }, rivers, stepSeconds) {
  const [c1, c2, c3, c4] = Array.from({ length: 4 }, () => new Float64Array(rivers.length))
  for (let position = 0; position < rivers.length; position++) {
    const river = rivers[position]
    if (!(k[river] > 0 && k[river] < Infinity && x[river] >= 0 && x[river] <= 0.5)) {
      throw new Error(`river ${riverIds[river]} has k ${k[river]} and x ${x[river]}; need k > 0 and 0 <= x <= 0.5`)
    }
    const stepOverK = stepSeconds / k[river]
    const denominator = stepOverK + 2 * (1 - x[river])
    c1[position] = Math.fround((stepOverK - 2 * x[river]) / denominator)
    c2[position] = Math.fround((stepOverK + 2 * x[river]) / denominator)
    c3[position] = Math.fround((2 * (1 - x[river]) - stepOverK) / denominator)
    c4[position] = Math.fround(Math.fround(c1[position] + c2[position]) / stepSeconds)
    if (Math.abs(c1[position] + c2[position] + c3[position] - 1) > 1e-5) {
      throw new Error(`river ${riverIds[river]} has Muskingum coefficients that do not sum to 1`)
    }
  }
  return { c1, c2, c3, c4 }
}

/**
 * The grid cells the routed catchments cover, by their position in the runoff grid, sorted by runoff chunk so that each
 * chunk's cells fill consecutive rows of the runoff read.
 */
function indexRunoffCells(weights, riverOfWeight, positionOfRiver, runoff) {
  const [, nY, nX] = runoff.array.shape
  const [, chunkHeight, chunkWidth] = runoff.array.chunks
  const cellOfKey = new Map()
  for (let weight = 0; weight < riverOfWeight.length; weight++) {
    if (positionOfRiver[riverOfWeight[weight]] < 0) continue
    const [y, x] = [weights.y_index[weight], weights.x_index[weight]]
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
 * Each routed river's weights as sparse rows: the runoff cell of each weight, and the multiplier that turns the cell's
 * runoff depth into its share of the river's forcing, c4 times the catchment runoff volume it adds.
 */
function weighRiverCells(weights, riverOfWeight, positionOfRiver, catchmentAreas, { c4 }, { cellOfKey }, runoff) {
  const nX = runoff.array.shape[2]
  const weightStart = new Int32Array(c4.length + 1)
  for (let weight = 0; weight < riverOfWeight.length; weight++) {
    const position = positionOfRiver[riverOfWeight[weight]]
    if (position >= 0) weightStart[position + 1]++
  }
  for (let position = 0; position < c4.length; position++) weightStart[position + 1] += weightStart[position]
  const weightCell = new Int32Array(weightStart[c4.length])
  const weightForcing = new Float64Array(weightStart[c4.length])
  const nextWeight = weightStart.slice(0, c4.length)
  for (let weight = 0; weight < riverOfWeight.length; weight++) {
    const river = riverOfWeight[weight]
    const position = positionOfRiver[river]
    if (position < 0) continue
    const slot = nextWeight[position]++
    weightCell[slot] = cellOfKey.get(weights.y_index[weight] * nX + weights.x_index[weight])
    weightForcing[slot] = c4[position] * catchmentAreas[river] * weights.proportion[weight] * runoff.metersPerUnit
  }
  return { weightStart, weightCell, weightForcing }
}

const CAP_DIVISORS = [1, 2, 3, 4, 6, 8, 12, 16] // the caps on a region tried are the rivers per worker over these

/**
 * Route the network's regions on the pool's workers at once, then its main stem in this thread with each region's
 * outflow added into the stem river it drains into. Returns the target's series, the one outlet of the stem.
 */
async function routeRegionsInParallel(network, runoffByCell, nSteps, workerPool) {
  const { riversOfWorker, stemRivers } = partitionRivers(network.downstreamPositions, workerPool.size)
  const routedRegions = await Promise.all(riversOfWorker.map(async rivers => {
    const part = extractRivers(network, runoffByCell, rivers, nSteps)
    const transfer = [part.runoffByCell, ...Object.values(part.network)].map(array => array.buffer)
    const task = { kind: 'routeRivers', network: part.network, runoffByCell: part.runoffByCell, nSteps }
    return { outlets: part.outlets, outflows: await workerPool.run(task, transfer) }
  }))
  const stem = extractRivers(network, runoffByCell, stemRivers, nSteps, routedRegions)
  return routeRivers(stem.network, stem.runoffByCell, nSteps)
}

/**
 * Split the rivers into regions for ``nWorkers`` workers and a main stem routed after them. A region is a subtree of
 * at most cap rivers draining into a river with more, and the stem is the target and every river with more than cap
 * upstream. Regions are packed onto the workers largest first, each onto the least loaded, and of the caps tried, the
 * one kept finishes soonest: the most loaded worker's rivers plus the stem's.
 */
function partitionRivers(downstreamPositions, nWorkers) {
  const nRivers = downstreamPositions.length
  const upstreamCounts = new Int32Array(nRivers).fill(1)
  for (let river = 0; river < nRivers; river++) {
    if (downstreamPositions[river] >= 0) upstreamCounts[downstreamPositions[river]] += upstreamCounts[river]
  }
  const partitions = CAP_DIVISORS.map(divisor => {
    return partitionAtCap(downstreamPositions, upstreamCounts, Math.ceil(nRivers / (nWorkers * divisor)), nWorkers)
  })
  const best = partitions.reduce((best, partition) => (partition.cost < best.cost ? partition : best))
  const riversOfWorker = Array.from({ length: nWorkers }, () => [])
  const stemRivers = []
  for (let river = 0; river < nRivers; river++) {
    const region = best.regionOfRiver[river]
    if (region < 0) stemRivers.push(river)
    else riversOfWorker[best.workerOfRegion[region]].push(river)
  }
  return {
    riversOfWorker: riversOfWorker.filter(rivers => rivers.length > 0).map(rivers => Int32Array.from(rivers)),
    stemRivers: Int32Array.from(stemRivers),
  }
}

function partitionAtCap(downstreamPositions, upstreamCounts, cap, nWorkers) {
  const regionOfRiver = new Int32Array(downstreamPositions.length).fill(-1)
  const regionSizes = []
  let nStemRivers = 0
  for (let river = downstreamPositions.length - 1; river >= 0; river--) {
    const downstream = downstreamPositions[river]
    if (downstream < 0 || upstreamCounts[river] > cap) nStemRivers++
    else if (downstream >= 0 && regionOfRiver[downstream] >= 0) regionOfRiver[river] = regionOfRiver[downstream]
    else regionOfRiver[river] = regionSizes.push(upstreamCounts[river]) - 1
  }
  const workerOfRegion = new Int32Array(regionSizes.length)
  const loads = new Float64Array(nWorkers)
  const largestFirst = regionSizes.map((_, region) => region).sort((a, b) => regionSizes[b] - regionSizes[a])
  for (const region of largestFirst) {
    workerOfRegion[region] = loads.indexOf(Math.min(...loads))
    loads[workerOfRegion[region]] += regionSizes[region]
  }
  return { regionOfRiver, workerOfRegion, cost: Math.max(...loads) + nStemRivers }
}

/**
 * The part of the network made of ``rivers``, positions in routing order, with its own rows of runoff. A river that
 * drains out of the part is one of its outlets. The outflows of the outlets of ``routedRegions`` are injected into the
 * rivers of the part they drain into.
 */
function extractRivers(network, runoffByCell, rivers, nSteps, routedRegions = []) {
  const localPosition = new Int32Array(network.downstreamPositions.length).fill(-1)
  rivers.forEach((river, local) => { localPosition[river] = local })
  const downstreamPositions = rivers.map(river => {
    return network.downstreamPositions[river] >= 0 ? localPosition[network.downstreamPositions[river]] : -1
  })
  const outlets = rivers.filter((_, local) => downstreamPositions[local] < 0)
  const [c1, c2, c3] = [network.c1, network.c2, network.c3].map(c => Float64Array.from(rivers, river => c[river]))
  const { weights, cells } = extractWeights(network, rivers)
  const partRunoff = new Float32Array(cells.length * nSteps)
  cells.forEach((cell, local) => {
    partRunoff.set(runoffByCell.subarray(cell * nSteps, (cell + 1) * nSteps), local * nSteps)
  })
  const injections = routedRegions.flatMap(({ outlets, outflows }) => Array.from(outlets, (outlet, index) => ({
    river: localPosition[network.downstreamPositions[outlet]],
    series: outflows.subarray(index * nSteps, (index + 1) * nSteps),
  }))).sort((a, b) => a.river - b.river)
  const injected = injections.length === 0 ? {} : {
    injectedRivers: Int32Array.from(injections, injection => injection.river),
    injectedSeries: injections.map(injection => injection.series),
  }
  return { network: { downstreamPositions, c1, c2, c3, ...weights, ...injected }, runoffByCell: partRunoff, outlets }
}

/** The weights of ``rivers`` as their own sparse rows, and the cells they read, numbered in the order first read. */
function extractWeights({ weightStart, weightCell, weightForcing }, rivers) {
  const partStart = new Int32Array(rivers.length + 1)
  rivers.forEach((river, local) => {
    partStart[local + 1] = partStart[local] + weightStart[river + 1] - weightStart[river]
  })
  const partCell = new Int32Array(partStart[rivers.length])
  const partForcing = new Float64Array(partStart[rivers.length])
  const localCell = new Map()
  rivers.forEach((river, local) => {
    for (let weight = weightStart[river]; weight < weightStart[river + 1]; weight++) {
      if (!localCell.has(weightCell[weight])) localCell.set(weightCell[weight], localCell.size)
      partCell[partStart[local] + weight - weightStart[river]] = localCell.get(weightCell[weight])
      partForcing[partStart[local] + weight - weightStart[river]] = weightForcing[weight]
    }
  })
  const weights = { weightStart: partStart, weightCell: partCell, weightForcing: partForcing }
  return { weights, cells: [...localCell.keys()] }
}
