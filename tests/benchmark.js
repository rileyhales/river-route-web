/**
 * Time each stage of routing the test data, in this thread and with pools of workers on node's worker threads, which
 * run the same V8 as a Chromium page's workers, and then each routing kernel alone on the network of each main outlet.
 * Each is run once to warm up, which is reported as the first, and then --repeats times, averaged.
 *
 *     node tests/benchmark.js --workers 1,4,8 --repeats 2
 */
import { readdirSync, readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { Worker as NodeWorker } from 'node:worker_threads'
import { createServer } from 'vite'
import { routeRivers as routeInJavaScript } from '../src/muskingum.js'
import { kernelModule, routeRivers as routeInWasm } from '../src/muskingum-wasm.js'
import { prepareRouting, routeHydrograph } from '../src/routing.js'
import { createWorkerPool } from '../src/worker-pool.js'

const { values: options } = parseArgs({
  options: { workers: { type: 'string', default: '1,4,8' }, repeats: { type: 'string', default: '2' } },
})
const poolSizes = options.workers.split(',').map(Number)
const repeats = Number(options.repeats)
const expectedDirectory = new URL('../data/expected/', import.meta.url)

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

const jsrrDirectory = new URL('..', import.meta.url).pathname
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

const server = await createServer({ root: jsrrDirectory, server: { port: 0 }, logLevel: 'error' })
await server.listen()
const dataUrl = new URL('data/', server.resolvedUrls.local[0])
for (const name of readdirSync(expectedDirectory).filter(file => file.endsWith('.json'))) {
  const expected = JSON.parse(readFileSync(new URL(name, expectedDirectory), 'utf8'))
  const inputs = {
    routingParametersUrl: new URL(expected.routing_parameters, dataUrl).href,
    gridWeightsUrl: new URL(expected.grid_weights, dataUrl).href,
    runoffUrl: new URL(expected.runoff, dataUrl).href,
  }
  for (const riverId of Object.keys(expected.hydrographs).map(Number)) {
    for (const poolSize of poolSizes) {
      const pool = poolSize > 1 ? createWorkerPool(() => startWebWorker('../src/pool-worker.js'), poolSize) : undefined
      const where = pool === undefined ? 'this thread' : `${poolSize} workers`
      console.log(`${where.padEnd(12)} ${await timeRouting({ ...inputs, riverId }, pool)}`)
      await pool?.terminate()
    }
  }
  const { riverId, network, runoffByCell, nSteps } = await prepareRouting(inputs)
  for (const [kernel, route] of [['javascript', routeInJavaScript], [`${kernelModule} wasm`, routeInWasm]]) {
    const timed = timeCalls(() => route(network, runoffByCell, nSteps))
    console.log(`${kernel.padEnd(12)} kernel alone, river ${riverId} (${network.c1.length} rivers)  ${timed}`)
  }
}
await server.close()
