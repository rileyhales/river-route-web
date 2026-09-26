/**
 * The routing kernel of muskingum.c, compiled to WebAssembly by build-wasm.js, as a routeRivers that takes what
 * muskingum.js's does and returns the same series in float32. Each call lays its arrays out in the module's memory, one
 * after another from where the module's own memory ends, growing it as needed, and copies the outlets' series back out.
 */
const ALIGNMENT = 16 // bytes: every array starts on a boundary of the module's 128 bit vectors
const WASM_PAGE_BYTES = 65536
// rivers, or time steps, routed per call into the module, so that the browser swaps in optimized code between calls;
// see muskingum.c
const RIVERS_PER_CALL = 256
const STEPS_PER_CALL = 32

// written out in full so that vite finds both modules and copies them into a build
const RELAXED_MODULE = new URL('./muskingum-relaxed.wasm', import.meta.url)
const MODULE = new URL('./muskingum.wasm', import.meta.url)

/** Which module routes: 'relaxed' where the browser compiles relaxed SIMD, 'baseline' where it does not. */
export let kernelModule = 'relaxed'
const kernel = await instantiateKernel()

async function instantiateKernel() {
  try {
    return (await WebAssembly.instantiate(await readModule(RELAXED_MODULE), {})).instance.exports
  } catch (error) {
    if (!(error instanceof WebAssembly.CompileError)) throw error
    kernelModule = 'baseline'
    return (await WebAssembly.instantiate(await readModule(MODULE), {})).instance.exports
  }
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

/** Raise the problem a kernel function reports as a negative number; otherwise give back what it returned. */
function checked(returned) {
  if (returned >= 0) return returned
  const text = new Uint8Array(kernel.memory.buffer, kernel.describe_problem(returned))
  const problem = new TextDecoder().decode(text.subarray(0, text.indexOf(0)))
  throw new Error(`the routing kernel refused the network: ${problem}`)
}

/**
 * Lay out arrays of the given types and lengths one after another from ``start``, growing the module's memory to hold
 * them, and return their byte offsets, views of them, and where they end. Growing the memory again detaches these
 * views, whose offsets then read 0, so the offsets are kept apart from them.
 */
function layOut(start, arrays) {
  let end = start
  const offsets = arrays.map(([ArrayType, length]) => {
    const offset = end
    end = Math.ceil((end + length * ArrayType.BYTES_PER_ELEMENT) / ALIGNMENT) * ALIGNMENT
    return offset
  })
  const missing = end - kernel.memory.buffer.byteLength
  if (missing > 0) kernel.memory.grow(Math.ceil(missing / WASM_PAGE_BYTES))
  const views = arrays.map(([ArrayType, length], index) => new ArrayType(kernel.memory.buffer, offsets[index], length))
  return { offsets, views, end }
}

/** Copy each row of ``series`` into ``padded``, whose rows are ``nPadded`` long, with zeros after each row's steps. */
function copyPadded(padded, series, nSteps, nPadded) {
  for (let row = 0; row < series.length / nSteps; row++) {
    padded.set(series.subarray(row * nSteps, (row + 1) * nSteps), row * nPadded)
    padded.fill(0, row * nPadded + nSteps, (row + 1) * nPadded)
  }
}

/**
 * Lay a network and its runoff out in the module's memory, in the order start_routing and start_stepping take them,
 * and then the scratch count_peak_inflow_rows needs. Returns the counts both kernels take and the layout.
 */
function layOutNetwork(network, runoffByCell, nSteps) {
  const { downstreamPositions, c1, c2, c3, weightStart, weightCell, weightForcing } = network
  const { injectedRivers = new Int32Array(0), injectedSeries = [] } = network
  const [nRivers, nCells, nInjected] = [downstreamPositions.length, runoffByCell.length / nSteps, injectedRivers.length]
  const nPadded = kernel.padded_steps(nSteps)
  if (nPadded === 0 || !Number.isInteger(nCells)) throw new Error(`the routing kernel cannot route ${nSteps} steps`)
  const inputs = layOut(kernel.__heap_base.value, [
    [Int32Array, nRivers], [Float32Array, nRivers], [Float32Array, nRivers], [Float32Array, nRivers],
    [Int32Array, nRivers + 1], [Int32Array, weightCell.length], [Float32Array, weightForcing.length],
    [Float32Array, nCells * nPadded], [Int32Array, nInjected], [Float32Array, nInjected * nPadded],
    [Uint8Array, nRivers],
  ])
  const given = [downstreamPositions, c1, c2, c3, weightStart, weightCell, weightForcing]
  given.forEach((values, index) => inputs.views[index].set(values))
  inputs.views[8].set(injectedRivers)
  copyPadded(inputs.views[7], runoffByCell, nSteps, nPadded)
  injectedSeries.forEach((series, index) => {
    copyPadded(inputs.views[9].subarray(index * nPadded), series, nSteps, nPadded)
  })
  const nOutlets = downstreamPositions.filter(position => position < 0).length
  return { nRivers, nCells, nInjected, nOutlets, nPadded, inputs }
}

/**
 * Route rivers in order, each river's whole series before the next, and return the series of every outlet, a river
 * whose downstream position is -1, as consecutive rows in routing order. See routeRivers in muskingum.js.
 */
export function routeRivers(network, runoffByCell, nSteps) {
  return routeRiversByTimeWindow(network, runoffByCell, nSteps)
}

/**
 * Route every river for a window of ``stepsPerWindow`` steps, a whole number of 8, before the next window, each river's
 * steps of a window before the next river's, and return what routeRivers does. Each river carries its discharge and
 * inflow from one window into the next, and the last window routes the steps that are left. ``onWindow``, when given,
 * is handed the first step of each window and every river's discharge in it, a row of ``stepsPerWindow`` per river in
 * routing order, a view of the module's memory that the next window overwrites. Without a window, every step is routed
 * at once: routeRivers.
 */
export function routeRiversByTimeWindow(network, runoffByCell, nSteps, stepsPerWindow, onWindow) {
  const { nRivers, nCells, nInjected, nOutlets, nPadded, inputs } = layOutNetwork(network, runoffByCell, nSteps)
  const nWindow = stepsPerWindow ?? nPadded
  const stride = kernel.row_stride(nWindow)
  const [downstreamOffset, injectedOffset, hasRowOffset] = [inputs.offsets[0], inputs.offsets[8], inputs.offsets[10]]
  const peakRows = kernel.count_peak_inflow_rows(nRivers, downstreamOffset, nInjected, injectedOffset, hasRowOffset)
  const nRows = checked(peakRows)
  const inWindows = nWindow < nPadded
  // the inflow rows, row_of_river, free_rows, lateral, the routing state kept between calls, and in windows, each
  // river's carried discharge and inflow and, when onWindow is given, its discharge in the window
  const work = layOut(inputs.end, [
    [Float32Array, (nRows + nOutlets) * stride], [Int32Array, nRivers], [Int32Array, nRows], [Float32Array, nWindow],
    [Uint8Array, kernel.routing_size()], [Float32Array, inWindows ? nRivers : 0],
    [Float32Array, inWindows ? nRivers : 0], [Float32Array, onWindow === undefined ? 0 : nRivers * nWindow],
  ])
  const routing = work.offsets[4]
  const [carriedDischarge, carriedInflow] = inWindows ? [work.offsets[5], work.offsets[6]] : [0, 0]
  const windowDischarge = onWindow === undefined ? 0 : work.offsets[7]
  checked(kernel.start_routing(routing, nRivers, nSteps, nWindow, nCells, nInjected, nRows, nOutlets,
    ...inputs.offsets.slice(0, 10), ...work.offsets.slice(0, 4), carriedDischarge, carriedInflow, windowDischarge))
  const outlets = new Float32Array(nOutlets * nSteps)
  const firstOutletStep = nRows * stride + (stride - nWindow) // after the pool's rows and the outlet row's header
  for (let firstStep = 0; firstStep < nSteps; firstStep += nWindow) {
    if (firstStep > 0) checked(kernel.next_window(routing))
    for (let riversLeft = nRivers; riversLeft > 0;) {
      riversLeft = checked(kernel.route_next_rivers(routing, RIVERS_PER_CALL))
    }
    const steps = Math.min(nWindow, nSteps - firstStep)
    for (let outlet = 0; outlet < nOutlets; outlet++) {
      const start = firstOutletStep + outlet * stride
      outlets.set(work.views[0].subarray(start, start + steps), outlet * nSteps + firstStep)
    }
    onWindow?.(firstStep, work.views[7])
  }
  return outlets
}

/**
 * Route every river for one time step before the next and return what routeRivers does. ``onStep``, when given, is
 * handed each step and every river's discharge after it, in routing order, a view of the module's memory that the next
 * step overwrites. See routeRiversByTimeStep in muskingum.js.
 *
 * The rivers are routed in the order of their topological levels, headwaters first, and within a level in routing
 * order. A river's push into the river it drains into is read back by the very next river three times in four in
 * routing order, which chains every river on the one before; no river pushes into one of its own level, which breaks
 * that chain, and the Columbia routed 3.2 times faster.
 */
export function routeRiversByTimeStep(network, runoffByCell, nSteps, onStep) {
  const { leveled, levelStarts, order } = orderByLevel(network)
  const { nRivers, nCells, nInjected, nOutlets, inputs } = layOutNetwork(leveled, runoffByCell, nSteps)
  // the level starts, discharge, outlet_series, the two blocks of scratch, the stepping state kept between calls, and,
  // when onStep is given, the position in level order of each river in routing order and its discharge in routing order
  const handing = onStep === undefined ? 0 : nRivers
  const work = layOut(inputs.end, [
    [Int32Array, levelStarts.length], [Float32Array, nRivers], [Float32Array, nOutlets * nSteps],
    [Float32Array, kernel.stepping_scratch_floats(nRivers)],
    [Int32Array, kernel.stepping_scratch_ints(nRivers, nOutlets)],
    [Uint8Array, kernel.stepping_size()], [Int32Array, handing], [Float32Array, handing],
  ])
  work.views[0].set(levelStarts)
  order.forEach((river, position) => { work.views[6][river] = position })
  const stepping = work.offsets[5]
  checked(kernel.start_stepping(stepping, nRivers, levelStarts.length - 1, nSteps, nCells, nInjected, nOutlets,
    work.offsets[0], ...inputs.offsets.slice(0, 10), ...work.offsets.slice(1, 5)))
  const stepsPerCall = onStep === undefined ? STEPS_PER_CALL : 1
  for (let step = 0; step < nSteps; step += stepsPerCall) {
    checked(kernel.route_next_steps(stepping, stepsPerCall))
    if (onStep !== undefined) {
      checked(kernel.copy_in_routing_order(stepping, work.offsets[6], work.offsets[7]))
      onStep(step, work.views[7])
    }
  }
  // the outlets' rows, from the order their levels put them in back to routing order
  const outletPositions = Int32Array.from(leveled.downstreamPositions.keys()).filter(river => {
    return leveled.downstreamPositions[river] < 0
  })
  const rows = Array.from(outletPositions.keys()).sort((a, b) => order[outletPositions[a]] - order[outletPositions[b]])
  const outlets = new Float32Array(nOutlets * nSteps)
  rows.forEach((row, index) => outlets.set(work.views[2].subarray(row * nSteps, (row + 1) * nSteps), index * nSteps))
  return outlets
}

/**
 * The network with its rivers in the order of their topological levels, where a headwater is level 0 and a river is one
 * level above its highest upstream river, and within a level in routing order; the position of each level's first
 * river, then the count of rivers; and ``order``, the routing position of each river it lists.
 */
function orderByLevel(network) {
  const { downstreamPositions, c1, c2, c3, weightStart, weightCell, weightForcing } = network
  const { injectedRivers = new Int32Array(0), injectedSeries = [] } = network
  const nRivers = downstreamPositions.length
  const level = new Int32Array(nRivers)
  for (let river = 0; river < nRivers; river++) {
    const downstream = downstreamPositions[river]
    if (downstream >= 0) level[downstream] = Math.max(level[downstream], level[river] + 1)
  }
  const order = Int32Array.from(downstreamPositions.keys()).sort((a, b) => level[a] - level[b] || a - b)
  const position = new Int32Array(nRivers)
  order.forEach((river, index) => { position[river] = index })
  const weightOrder = new Int32Array(weightCell.length)
  const leveledStart = new Int32Array(nRivers + 1)
  order.forEach((river, index) => {
    const [first, stop] = [weightStart[river], weightStart[river + 1]]
    leveledStart[index + 1] = leveledStart[index] + stop - first
    for (let weight = first; weight < stop; weight++) weightOrder[leveledStart[index] + weight - first] = weight
  })
  const levelStarts = new Int32Array(Math.max(...level) + 2)
  level.forEach(riverLevel => { levelStarts[riverLevel + 1]++ })
  for (let index = 1; index < levelStarts.length; index++) levelStarts[index] += levelStarts[index - 1]
  const injectedPositions = Array.from(injectedRivers, river => position[river])
  const injections = Array.from(injectedRivers.keys()).sort((a, b) => injectedPositions[a] - injectedPositions[b])
  const leveled = {
    downstreamPositions: order.map(river => {
      return downstreamPositions[river] >= 0 ? position[downstreamPositions[river]] : -1
    }),
    c1: Float64Array.from(order, river => c1[river]),
    c2: Float64Array.from(order, river => c2[river]),
    c3: Float64Array.from(order, river => c3[river]),
    weightStart: leveledStart,
    weightCell: weightOrder.map(weight => weightCell[weight]),
    weightForcing: Float64Array.from(weightOrder, weight => weightForcing[weight]),
    injectedRivers: Int32Array.from(injections, injection => injectedPositions[injection]),
    injectedSeries: injections.map(injection => injectedSeries[injection]),
  }
  return { leveled, levelStarts, order }
}
