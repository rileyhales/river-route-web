/**
 * river-route's routing kernel, the C of river_route/kernels/c compiled to WebAssembly and published on npm as
 * river-route, routing the networks prepare.js makes. A network is prepareRouting's result with the
 * weights of each river's runoff cells added: weightStarts, each river's first weight then their count; weightCells,
 * the cell each weight reads; and weights, the volume (m³) a meter of runoff depth in the cell gives the river. Runoff
 * is { depth, nSteps }: each cell's nSteps runoff depths (m) one after another, cell after cell, the layout of
 * runoffByCell.
 *
 * Every route lays its arrays out in the module's memory from where the module's own memory ends, over the last
 * route's, and starts from no discharge. Each river is routed over a window of steps before the next river, and every
 * river over a window before the next window, so a route holds one window of the runoff and of every river's discharge
 * in the module, whatever the length of the run. routeRivers routes a run and keeps the series of only the rivers it is
 * asked for, and startWindows routes a window at a time for a caller that goes on as it routes: a map stepping through
 * a run, or runoff given as the routing goes.
 */
const ALIGNMENT = 16 // bytes: every array starts on a boundary of the module's 128 bit vectors
const WASM_PAGE_BYTES = 65536
// Rivers routed per call into the module. V8 swaps a function's optimized code in only between calls, so routed in one
// call, a route ran its first optimized code only once it was done: nearly three times as long.
const RIVERS_PER_CALL = 256
const WINDOW_FLOATS = 2 ** 25 // the most floats, 128 MB, one window of every river's discharge takes by default
const NETWORK_STRUCT_INTS = 14 // the fields of routing.h's structs, every one four bytes in 32 bit WebAssembly
const RUNOFF_STRUCT_INTS = 4
const JOB_STRUCT_INTS = 8
const NETWORK_ARRAYS = [
  ['subReachStarts', Int32Array], ['inflowRiverStarts', Int32Array], ['inflowRivers', Int32Array],
  ['c1', Float32Array], ['c2', Float32Array], ['c3', Float32Array], ['c4', Float32Array],
  ['weightStarts', Int32Array], ['weightCells', Int32Array], ['weights', Float32Array],
]

// the river-route package's modules, by their path in node_modules so that node reads them and vite finds both and
// copies them into a build
const MODULES = {
  relaxed: new URL('../node_modules/river-route/routing-relaxed.wasm', import.meta.url),
  baseline: new URL('../node_modules/river-route/routing.wasm', import.meta.url),
}

/** The module that routes: 'relaxed' where the runtime compiles relaxed SIMD, which routes faster, else 'baseline'. */
export let kernelModule = 'relaxed'
let kernel = await instantiate('relaxed').catch(error => {
  if (!(error instanceof WebAssembly.CompileError)) throw error
  return instantiate('baseline')
})
let nLayouts = 0 // the routes laid out in the module's memory so far, each over the one before

/** Route with the module named, 'relaxed' or 'baseline', from now on. */
export async function loadKernelModule(name) {
  kernel = await instantiate(name)
  nLayouts++
}

async function instantiate(name) {
  const url = MODULES[name]
  if (url === undefined) throw new Error(`the kernel module is relaxed or baseline, not ${name}`)
  const { instance } = await WebAssembly.instantiate(await readModule(url), {})
  kernelModule = name
  return instance.exports
}

async function readModule(url) {
  if (url.protocol === 'file:') { // node, which runs the tests, does not fetch files
    const nodeFileSystem = 'node:fs/promises' // named in a variable so that vite leaves this import to node
    return (await import(/* @vite-ignore */ nodeFileSystem)).readFile(url)
  }
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered ${response.status} ${response.statusText}`)
  return response.arrayBuffer()
}

/** Raise the problem the kernel returned, rr_describe_problem's description of it, unless it is RR_OK. */
function checked(problem) {
  if (problem === 0) return
  const text = new Uint8Array(kernel.memory.buffer, kernel.rr_describe_problem(problem))
  throw new Error(`the routing kernel refused to route: ${new TextDecoder().decode(text.subarray(0, text.indexOf(0)))}`)
}

/**
 * Lay out arrays of the given types and lengths one after another from the end of the module's own memory, growing the
 * memory to hold them, and return their byte offsets and views of them. Growing the memory again detaches these views.
 */
function layOut(arrays) {
  nLayouts++
  let end = Math.ceil(kernel.__heap_base.value / ALIGNMENT) * ALIGNMENT
  const offsets = arrays.map(([ArrayType, length]) => {
    const offset = end
    end = Math.ceil((end + length * ArrayType.BYTES_PER_ELEMENT) / ALIGNMENT) * ALIGNMENT
    return offset
  })
  const missing = end - kernel.memory.buffer.byteLength
  if (missing > 0) kernel.memory.grow(Math.ceil(missing / WASM_PAGE_BYTES))
  const views = arrays.map(([ArrayType, length], index) => new ArrayType(kernel.memory.buffer, offsets[index], length))
  return { offsets, views }
}

/**
 * Lay a network out in the module's memory, its arrays and its rr_network, then the arrays of ``route``, the rest of a
 * route's arrays, after them. Returns the address of the rr_network, the counts, and the offsets and views of the
 * route's arrays.
 */
function layOutNetwork(network, route) {
  const nRivers = network.subReachStarts.length - 1
  const nSubReaches = network.subReachStarts[nRivers]
  const given = NETWORK_ARRAYS.map(([name, ArrayType]) => [ArrayType, network[name]])
  const missing = given.findIndex(([, values]) => values === undefined)
  if (missing >= 0) throw new Error(`the network lacks ${NETWORK_ARRAYS[missing][0]}`)
  // the kernel is given one count for the arrays that share it, so they must share its length
  const starts = [network.subReachStarts, network.inflowRiverStarts, network.weightStarts]
  const coefficients = [network.c1, network.c2, network.c3, network.c4]
  if (starts.some(values => values.length !== nRivers + 1) || coefficients.some(values => values.length !== nSubReaches)
      || network.weightCells.length !== network.weights.length) {
    throw new Error('the arrays of the network that share a count do not share its length')
  }
  const { offsets, views } = layOut([
    ...given.map(([ArrayType, values]) => [ArrayType, values.length]),
    [Int32Array, NETWORK_STRUCT_INTS], ...route,
  ])
  given.forEach(([, values], index) => views[index].set(values))
  const arrayAddresses = offsets.slice(0, given.length)
  views[given.length].set([
    nRivers, nSubReaches, network.inflowRivers.length, network.weights.length, ...arrayAddresses,
  ])
  return {
    network: offsets[given.length],
    nRivers,
    nSubReaches,
    offsets: offsets.slice(given.length + 1),
    views: views.slice(given.length + 1),
  }
}

/** The cells of runoff holding nSteps steps of each. */
function cellsOf(depth, nSteps) {
  const nCells = depth.length / nSteps
  if (!(Number.isInteger(nSteps) && nSteps > 0 && Number.isInteger(nCells))) {
    throw new Error(`the runoff does not hold ${nSteps} steps of every cell`)
  }
  return nCells
}

/** The rivers of keep, checked to be rivers of the network. */
function keptRivers(keep, nRivers) {
  const rivers = Int32Array.from(keep)
  if (rivers.some(river => !(river >= 0 && river < nRivers))) throw new Error(`a river kept is not one of ${nRivers}`)
  return rivers
}

/**
 * Check, as routing.c's check_job does, that the blocks come in routing order, none overlapping the one before or
 * leaving the network, since routeRivers hands the kernel a block at a time; and that each given river is a river of
 * the network that no block routes, with a series of nSteps. The kernel checks the blocks' rivers.
 */
function checkBlocksAndGiven(blocks, given, nRivers, nSteps) {
  let routedTo = 0
  for (let block = 0; block < blocks.starts.length; block++) {
    const [start, stop] = [blocks.starts[block], blocks.stops[block]]
    if (!(Number.isInteger(start) && Number.isInteger(stop) && start >= routedTo && stop >= start && stop <= nRivers)) {
      throw new Error('the blocks of rivers are not in routing order or leave the network')
    }
    routedTo = stop
  }
  if (blocks.stops.length !== blocks.starts.length) throw new Error('every block has a start and a stop')
  if (given === undefined) return
  if (given.series.length !== given.rivers.length * nSteps) {
    throw new Error(`the given series are not ${nSteps} steps of each given river`)
  }
  const routed = river => blocks.starts.some((start, block) => river >= start && river < blocks.stops[block])
  if (given.rivers.some(river => !(river >= 0 && river < nRivers) || routed(river))) {
    throw new Error('a given river is not a river of the network, or is one that a block routes')
  }
}

/**
 * Write the window of each given river into its row of discharge, rows of rowLength: its discharge at the start of the
 * window, none before the first step, and then at the end of each step.
 */
function writeGiven({ rivers, series }, discharge, rowLength, firstStep, steps, nSteps) {
  rivers.forEach((river, index) => {
    const first = index * nSteps + firstStep
    discharge[river * rowLength] = firstStep === 0 ? 0 : series[first - 1]
    discharge.set(series.subarray(first, first + steps), river * rowLength + 1)
  })
}

/** The pieces of at most RIVERS_PER_CALL rivers of the blocks, each block's start and stop, that one call routes. */
function piecesOf({ starts, stops }) {
  const pieces = []
  for (let block = 0; block < starts.length; block++) {
    for (let start = starts[block]; start < stops[block]; start += RIVERS_PER_CALL) {
      pieces.push([start, Math.min(start + RIVERS_PER_CALL, stops[block])])
    }
  }
  return pieces
}

/** The steps of a window whose discharge of every river fits in WINDOW_FLOATS, a whole number of eight, at least 8. */
function defaultWindow(nRivers) {
  const stepsPerRow = Math.floor(WINDOW_FLOATS / nRivers) - 1
  return Math.max(8, stepsPerRow - (stepsPerRow % 8))
}

/**
 * Route the rivers of ``network`` over every step of ``runoff`` and return the discharge of the rivers of
 * ``options.keep``, by default the outlets, at the end of every step: a row of nSteps for each, in the order of keep.
 * A window is ``options.stepsPerWindow`` steps, by default as many as fit in WINDOW_FLOATS for every river.
 * ``options.blocks``, { starts, stops }, routes only the rivers from each start up to its stop, each block in routing
 * order; ``options.given``, { rivers, series }, gives the discharge of rivers that are not routed and that routed
 * rivers drain from, a row of nSteps for each, from no discharge at the start: a worker routes a network's main stem
 * from the series that other workers routed its blocks to.
 */
export function routeRivers(network, runoff, options = {}) {
  const { nSteps } = runoff
  const nCells = cellsOf(runoff.depth, nSteps)
  const nRivers = network.subReachStarts.length - 1
  const { keep = network.outlets, blocks = { starts: [0], stops: [nRivers] }, given } = options
  const kept = keptRivers(keep, nRivers)
  checkBlocksAndGiven(blocks, given, nRivers, nSteps)
  const window = Math.min(nSteps, options.stepsPerWindow ?? defaultWindow(nRivers))
  const { stepper, routeBlocks, discharge } = layOutWindows(network, nCells, window)
  const series = new Float32Array(kept.length * nSteps)
  for (let firstStep = 0; firstStep < nSteps; firstStep += window) {
    const steps = Math.min(window, nSteps - firstStep)
    stepper.copyRunoff(runoff, firstStep, steps)
    if (given !== undefined) writeGiven(given, discharge, window + 1, firstStep, steps, nSteps)
    routeBlocks(steps, blocks)
    kept.forEach((river, index) => series.set(stepper.riverSeries(river), index * nSteps + firstStep))
  }
  return series
}

/**
 * Start routing every river of ``network`` a window of steps at a time, as routeRivers routes, from no discharge, for a
 * caller that goes on as it routes. The stepper's ``depth`` is the runoff depth (m) of the ``nCells`` cells of the
 * network's weights over the next window, each cell's ``stepsPerWindow`` steps one after another, which the caller
 * writes, or ``copyRunoff(runoff, firstStep, steps)`` copies from a run's runoff, before ``route(steps)`` routes that
 * many steps of it. Then ``dischargeAt(step, into)`` writes every river's discharge at the end of a step of the
 * window into ``into`` and returns it, and ``riverSeries(river)`` is a river's discharge at the end of each step of
 * the window. ``channelState()`` is every sub-reach's discharge, and ``setChannelState(values)`` sets it, and so each
 * river's, as if routed to it: zeros start the routing over, and one network's state carries into another that holds
 * its sub-reaches first. Each is a view of the module's memory that the next route overwrites. Routing another network
 * in this module lays it out over the stepper's arrays, and the stepper refuses to go on from then.
 */
export function startWindows(network, { nCells, stepsPerWindow }) {
  return layOutWindows(network, nCells, stepsPerWindow).stepper
}

/** startWindows's stepper, with what routeRivers adds: routing only blocks of rivers, and every river's discharge. */
function layOutWindows(network, nCells, window) {
  if (!(Number.isInteger(window) && window > 0)) throw new Error(`a window is a whole number of steps, not ${window}`)
  if (!(Number.isInteger(nCells) && nCells >= 0)) throw new Error(`runoff has a whole number of cells, not ${nCells}`)
  const nRivers = network.subReachStarts.length - 1
  const rowLength = window + 1 // each river's discharge at the start of the window, then at the end of each step
  const route = layOutNetwork(network, [
    [Float32Array, nCells * window], [Float32Array, network.subReachStarts[nRivers]],
    [Float32Array, nRivers * rowLength], [Int32Array, 2], [Int32Array, RUNOFF_STRUCT_INTS],
    [Int32Array, JOB_STRUCT_INTS],
  ])
  const checkLaidOut = checkerOfLayout()
  const [depthAddress, channelStateAddress, dischargeAddress, blockAddress, runoffAddress, jobAddress] = route.offsets
  const [depth, channelState, discharge, block, runoffStruct, jobStruct] = route.views
  ;[depth, channelState, discharge].forEach(view => view.fill(0)) // over whatever the last route left
  runoffStruct.set([nCells, window, depth.length, depthAddress])
  let stepsRouted = 0 // in the last window routed
  const routeBlocks = (steps, blocks) => {
    checkLaidOut()
    if (!(Number.isInteger(steps) && steps >= 1 && steps <= window)) {
      throw new Error(`a window routes 1 to ${window} steps, not ${steps}`)
    }
    for (const [start, stop] of piecesOf(blocks)) {
      block.set([start, stop])
      jobStruct.set([
        steps, 1, blockAddress, blockAddress + 4, channelStateAddress, dischargeAddress, rowLength, discharge.length,
      ])
      checked(kernel.rr_route_rivers(route.network, runoffAddress, jobAddress))
    }
    stepsRouted = steps
  }
  const everyRiver = { starts: [0], stops: [nRivers] }
  const checkStep = step => {
    if (!(Number.isInteger(step) && step >= 0 && step < stepsRouted)) {
      throw new Error(`the window routed last has ${stepsRouted} steps, not a step ${step}`)
    }
  }
  const stepper = {
    depth,
    copyRunoff(runoff, firstStep, steps) {
      checkLaidOut()
      if (cellsOf(runoff.depth, runoff.nSteps) !== nCells) throw new Error(`the runoff is not of ${nCells} cells`)
      if (!(Number.isInteger(firstStep) && firstStep >= 0 && steps <= window && firstStep + steps <= runoff.nSteps)) {
        throw new Error(`a window of ${window} steps cannot hold ${steps} steps from step ${firstStep}`)
      }
      for (let cell = 0; cell < nCells; cell++) {
        const first = cell * runoff.nSteps + firstStep
        depth.set(runoff.depth.subarray(first, first + steps), cell * window)
      }
    },
    route: steps => routeBlocks(steps, everyRiver),
    dischargeAt(step, into) {
      checkLaidOut()
      checkStep(step)
      if (into.length !== nRivers) throw new Error(`${into.length} values cannot hold ${nRivers} rivers' discharge`)
      for (let river = 0; river < nRivers; river++) into[river] = discharge[river * rowLength + 1 + step]
      return into
    },
    riverSeries(river) {
      checkLaidOut()
      if (!(river >= 0 && river < nRivers)) throw new Error(`river ${river} is not one of ${nRivers}`)
      return discharge.subarray(river * rowLength + 1, river * rowLength + 1 + stepsRouted)
    },
    channelState() {
      checkLaidOut()
      return channelState
    },
    setChannelState(values) {
      checkLaidOut()
      if (values.length !== channelState.length) {
        throw new Error(`${values.length} discharges cannot set ${channelState.length} sub-reaches'`)
      }
      channelState.set(values)
      stepsRouted = 0
    },
  }
  return { stepper, routeBlocks, discharge }
}

/** A check that the module's memory still holds the arrays laid out last, which throws once it does not. */
function checkerOfLayout() {
  const layout = nLayouts
  return () => {
    if (layout !== nLayouts) throw new Error('the routing kernel has routed another network since this one started')
  }
}
