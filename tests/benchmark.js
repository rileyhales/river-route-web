/**
 * Time each stage of routing the test data, region 7020014250 and the runoff of 1940, to its main outlet and to the
 * Willamette, in this thread and with pools of workers on node's worker threads, which run the same V8 as a Chromium
 * page's workers, and then the routing alone on the network of the main outlet: routeRivers keeping the outlet's
 * series, and a stepper of startWindows in windows of --windows steps, taking every river's discharge at each step.
 * Each is run once to warm up, which is reported as the first, and then --repeats times, averaged.
 *
 *     node tests/benchmark.js --workers 1,4,8 --windows 32,256 --repeats 2
 */
import { parseArgs } from 'node:util'
import { Worker as NodeWorker } from 'node:worker_threads'
import * as wasm from '../src/kernel.js'
import { createServer } from 'vite'
import { prepareRouting, routeHydrograph } from '../src/routing.js'
import { createWorkerPool } from '../src/worker-pool.js'

const { values: options } = parseArgs({
  options: {
    workers: { type: 'string', default: '1,4,8' },
    windows: { type: 'string', default: '32,256' },
    repeats: { type: 'string', default: '2' },
  },
})
const poolSizes = options.workers.split(',').map(Number)
const windows = options.windows.split(',').map(Number)
const repeats = Number(options.repeats)
const TESTED_REGION = 7020014250
const RIVERS = [undefined, 720184033] // the main outlet, the Columbia's mouth, and the Willamette at Portland

function startWebWorker(module) {
  const thread = new NodeWorker(new URL('web-worker-shim.js', import.meta.url), { workerData: { module } })
  const worker = { postMessage: (message, transfer) => thread.postMessage(message, transfer) }
  worker.terminate = () => thread.terminate()
  thread.on('message', data => worker.onmessage?.({ data }))
  thread.on('error', error => worker.onerror?.({ message: error.message }))
  return worker
}

async function timeRouting(inputs, workerPool) {
  const first = Object.values((await routeHydrograph(inputs, workerPool)).timings).reduce((sum, time) => sum + time)
  const totals = { inputs: 0, runoff: 0, routing: 0 }
  let routed
  for (let repeat = 0; repeat < repeats; repeat++) {
    routed = await routeHydrograph(inputs, workerPool)
    for (const stage of Object.keys(totals)) totals[stage] += routed.timings[stage] / repeats
  }
  const total = totals.inputs + totals.runoff + totals.routing
  const stages = Object.entries(totals).map(([stage, time]) => `${stage} ${time.toFixed(0).padStart(4)}`).join('  ')
  const totalsText = `total ${total.toFixed(0).padStart(4)} ms, first ${first.toFixed(0).padStart(4)} ms`
  return `river ${routed.riverId} (${routed.riversRouted} rivers)  ${stages}  ${totalsText}`
}

const riverRouteWebDirectory = new URL('..', import.meta.url).pathname
/** The milliseconds of the first call and the average of the next ``repeats``. */
function timeCalls(call) {
  const times = Array.from({ length: repeats + 1 }, () => {
    const start = performance.now()
    call()
    return performance.now() - start
  })
  const warm = times.slice(1).reduce((sum, time) => sum + time) / repeats
  return `${warm.toFixed(0).padStart(4)} ms, first ${times[0].toFixed(0).padStart(4)} ms`
}

const server = await createServer({ root: riverRouteWebDirectory, server: { port: 0 }, logLevel: 'error' })
await server.listen()
const dataUrl = new URL('data/', server.resolvedUrls.local[0])
const inputs = {
  routingParametersUrl: new URL(`routing/region=${TESTED_REGION}/network.parquet`, dataUrl).href,
  gridWeightsUrl: new URL(`routing/region=${TESTED_REGION}/gridweights_ERA5_${TESTED_REGION}.parquet`, dataUrl).href,
  runoffUrls: [new URL('forcings/era5/1940.zarr/ro', dataUrl).href],
}
for (const riverId of RIVERS) {
  for (const poolSize of poolSizes) {
    const pool = poolSize > 1 ? createWorkerPool(() => startWebWorker('../src/pool-worker.js'), poolSize) : undefined
    const where = pool === undefined ? 'this thread' : `${poolSize} workers`
    console.log(`${where.padEnd(12)} ${await timeRouting({ ...inputs, riverId }, pool)}`)
    await pool?.terminate()
  }
}
const { riverId, riverIds, network, runoffByCell, nSteps } = await prepareRouting(inputs)
const runoff = { depth: runoffByCell, nSteps }
const atStep = new Float32Array(riverIds.length)
/** Route every step with a stepper of startWindows in windows of ``window`` steps, taking every river's discharge. */
function routeWindows(window) {
  const stepper = wasm.startWindows(network, { nCells: runoffByCell.length / nSteps, stepsPerWindow: window })
  for (let first = 0; first < nSteps; first += window) {
    const steps = Math.min(window, nSteps - first)
    stepper.copyRunoff(runoff, first, steps)
    stepper.route(steps)
    for (let step = 0; step < steps; step++) stepper.dischargeAt(step, atStep)
  }
}
const kernels = {
  'routeRivers, the outlet': () => wasm.routeRivers(network, runoff),
  ...Object.fromEntries(windows.map(window => [`windows of ${window}, every step`, () => routeWindows(window)])),
}
const nSubReaches = network.subReachStarts[riverIds.length]
console.log(`kernels alone, river ${riverId} (${riverIds.length} rivers as ${nSubReaches} sub-reaches, `
  + `${nSteps} steps), ${wasm.kernelModule} wasm`)
for (const [kernel, route] of Object.entries(kernels)) console.log(`${kernel.padEnd(28)} ${timeCalls(route)}`)
await server.close()
