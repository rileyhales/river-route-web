/**
 * The routing kernel of muskingum.c, compiled to WebAssembly by build-wasm.js, as a routeRivers that takes what
 * muskingum.js's does and returns the same series in float32. Each call lays its arrays out in the module's memory, one
 * after another from where the module's own memory ends, growing it as needed, and copies the outlets' series back out.
 */
const ALIGNMENT = 16 // bytes: every array starts on a boundary of the module's 128 bit vectors
const WASM_PAGE_BYTES = 65536
// rivers routed per call into the module, so that the browser swaps in optimized code between calls; see muskingum.c
const RIVERS_PER_CALL = 256

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
 * Route rivers in order, each river's whole series before the next, and return the series of every outlet, a river
 * whose downstream position is -1, as consecutive rows in routing order. See routeRivers in muskingum.js.
 */
export function routeRivers(network, runoffByCell, nSteps) {
  const { downstreamPositions, c1, c2, c3, weightStart, weightCell, weightForcing } = network
  const { injectedRivers = new Int32Array(0), injectedSeries = [] } = network
  const [nRivers, nCells, nInjected] = [downstreamPositions.length, runoffByCell.length / nSteps, injectedRivers.length]
  const [nPadded, stride] = [kernel.padded_steps(nSteps), kernel.row_stride(nSteps)]
  if (nPadded === 0 || !Number.isInteger(nCells)) throw new Error(`the routing kernel cannot route ${nSteps} steps`)
  // in the order route_rivers takes them, then the scratch count_peak_inflow_rows needs
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
  const [downstreamOffset, injectedOffset, hasRowOffset] = [inputs.offsets[0], inputs.offsets[8], inputs.offsets[10]]
  const peakRows = kernel.count_peak_inflow_rows(nRivers, downstreamOffset, nInjected, injectedOffset, hasRowOffset)
  const nRows = checked(peakRows)
  const nOutlets = downstreamPositions.filter(position => position < 0).length
  // the inflow rows, row_of_river, free_rows, lateral, and the routing state kept between calls
  const work = layOut(inputs.end, [
    [Float32Array, (nRows + nOutlets) * stride], [Int32Array, nRivers], [Int32Array, nRows], [Float32Array, nPadded],
    [Uint8Array, kernel.routing_size()],
  ])
  const routing = work.offsets[4]
  checked(kernel.start_routing(routing, nRivers, nSteps, nCells, nInjected, nRows, nOutlets,
    ...inputs.offsets.slice(0, 10), ...work.offsets.slice(0, 4)))
  for (let riversLeft = nRivers; riversLeft > 0;) {
    riversLeft = checked(kernel.route_next_rivers(routing, RIVERS_PER_CALL))
  }
  const outlets = new Float32Array(nOutlets * nSteps)
  const firstStep = nRows * stride + (stride - nPadded) // the first outlet row's first step: after the pool, its header
  for (let outlet = 0; outlet < nOutlets; outlet++) {
    const start = firstStep + outlet * stride
    outlets.set(work.views[0].subarray(start, start + nSteps), outlet * nSteps)
  }
  return outlets
}
