/**
 * Route the test data over HTTP from a vite dev server the tests start, and require each hydrograph to match the one
 * river-route routes from the same inputs, which tests/prepare_test_data.py records in data/expected/.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { Worker as NodeWorker } from 'node:worker_threads'
import { createServer } from 'vite'
import * as javascript from '../src/muskingum.js'
import * as wasm from '../src/muskingum-wasm.js'
import { prepareRouting, readRoutingParameters, routeHydrograph } from '../src/routing.js'
import { createWorkerPool } from '../src/worker-pool.js'

const TOLERANCE = 10e-4 // as in river-route's tests: answers may differ by this share of the river's largest value
const JSRR_DIRECTORY = new URL('..', import.meta.url).pathname
const EXPECTED_DIRECTORY = new URL('../data/expected/', import.meta.url)
const expectedFiles = readdirSync(EXPECTED_DIRECTORY).filter(name => name.endsWith('.json'))

let server
let dataUrl

before(async () => {
  server = await createServer({ root: JSRR_DIRECTORY, server: { port: 0 }, logLevel: 'error' })
  await server.listen()
  dataUrl = new URL('data/', server.resolvedUrls.local[0])
})

after(() => server.close())

/** The expected hydrographs of one routing, and the URLs of the inputs they were routed from. */
function readExpected(name) {
  const expected = JSON.parse(readFileSync(new URL(name, EXPECTED_DIRECTORY), 'utf8'))
  const inputs = {
    routingParametersUrl: new URL(expected.routing_parameters, dataUrl).href,
    gridWeightsUrl: new URL(expected.grid_weights, dataUrl).href,
    runoffUrl: new URL(expected.runoff, dataUrl).href,
  }
  return { expected, inputs }
}

/** Require two hydrographs of one river to agree within TOLERANCE of the river's largest discharge. */
function assertSameHydrograph(actual, desired) {
  assert.equal(actual.length, desired.length, 'the hydrographs have different lengths')
  const largest = desired.reduce((most, value) => Math.max(most, Math.abs(value)), 0) || 1
  let worstStep = 0
  for (let step = 1; step < desired.length; step++) {
    if (Math.abs(actual[step] - desired[step]) > Math.abs(actual[worstStep] - desired[worstStep])) worstStep = step
  }
  const worst = Math.abs(actual[worstStep] - desired[worstStep]) / largest
  const worstDescribed = `step ${worstStep} is ${actual[worstStep]} against ${desired[worstStep]}, off by ${worst}`
  assert.ok(worst <= TOLERANCE, worstDescribed)
}

test('the test data has been prepared', () => {
  const prepare = `no expected hydrographs in ${EXPECTED_DIRECTORY.pathname}; run tests/prepare_test_data.py`
  assert.ok(expectedFiles.length > 0, prepare)
})

for (const name of expectedFiles) {
  describe(name, () => {
    test('routes the outlet that drains the largest area', async () => {
      const { expected, inputs } = readExpected(name)
      const routed = await routeHydrograph(inputs)
      assert.equal(routed.riverId, expected.outlet_river_id)
      assert.deepEqual(Array.from(routed.times), expected.dates)
      assertSameHydrograph(routed.discharge, expected.hydrographs[expected.outlet_river_id])
    })

    test('routes each other test river and only the rivers upstream of it', async () => {
      const { expected, inputs } = readExpected(name)
      const others = Object.keys(expected.hydrographs).map(Number).filter(river => river !== expected.outlet_river_id)
      for (const riverId of others) {
        const routed = await routeHydrograph({ ...inputs, riverId })
        assert.equal(routed.riverId, riverId)
        assertSameHydrograph(routed.discharge, expected.hydrographs[riverId])
      }
    })

    test('routes the outlet in time order, every river for each step before the next', async () => {
      const { expected, inputs } = readExpected(name)
      const routed = await routeHydrograph({ ...inputs, order: 'time' })
      assert.equal(routed.riverId, expected.outlet_river_id)
      assertSameHydrograph(routed.discharge, expected.hydrographs[expected.outlet_river_id])
    })

    test('names the river that is not in the routing parameters', async () => {
      const { inputs } = readExpected(name)
      await assert.rejects(routeHydrograph({ ...inputs, riverId: 1 }), /has no river 1$/)
    })

    test('names an order it does not route in', async () => {
      const { inputs } = readExpected(name)
      await assert.rejects(routeHydrograph({ ...inputs, order: 'sideways' }), /order must be 'river' or 'time'/)
    })

    test('names the input that cannot be read', async () => {
      const { inputs } = readExpected(name)
      const routingParametersUrl = `${inputs.routingParametersUrl}.missing`
      await assert.rejects(routeHydrograph({ ...inputs, routingParametersUrl }), /\.missing answered 404/)
    })
  })
}

/** A browser worker module on a node worker thread, behind the parts of the Web Worker interface the page uses. */
function startWebWorker(module) {
  const thread = new NodeWorker(new URL('web-worker-shim.js', import.meta.url), { workerData: { module } })
  const worker = {
    postMessage: (message, transfer) => thread.postMessage(message, transfer),
    terminate: () => thread.terminate(),
  }
  thread.on('message', data => worker.onmessage?.({ data }))
  thread.on('error', error => worker.onerror?.({ message: error.message }))
  return worker
}

describe('workers', () => {
  const [name] = expectedFiles

  test('a pool routes the same hydrograph, its workers reading the runoff and routing regions', async () => {
    const { expected, inputs } = readExpected(name)
    const pool = createWorkerPool(() => startWebWorker('../src/pool-worker.js'), 4)
    try {
      const routed = await routeHydrograph(inputs, pool)
      assert.equal(routed.riverId, expected.outlet_river_id)
      assertSameHydrograph(routed.discharge, expected.hydrographs[expected.outlet_river_id])
    } finally {
      await pool.terminate()
    }
  })

  test("a pool routes the time order the same, its regions' outflows pushed into the main stem", async () => {
    const { expected, inputs } = readExpected(name)
    const pool = createWorkerPool(() => startWebWorker('../src/pool-worker.js'), 4)
    try {
      const routed = await routeHydrograph({ ...inputs, order: 'time' }, pool)
      assertSameHydrograph(routed.discharge, expected.hydrographs[expected.outlet_river_id])
    } finally {
      await pool.terminate()
    }
  })

  test('a pool routes a river with nothing upstream the same as this thread', async () => {
    const { inputs } = readExpected(name)
    const { riverIds, downstreamIndices } = await readRoutingParameters(inputs.routingParametersUrl)
    const drainedInto = new Set(downstreamIndices)
    const headwater = riverIds[downstreamIndices.findIndex((_, river) => !drainedInto.has(river))]
    const pool = createWorkerPool(() => startWebWorker('../src/pool-worker.js'), 4)
    try {
      const alone = await routeHydrograph({ ...inputs, riverId: headwater })
      const pooled = await routeHydrograph({ ...inputs, riverId: headwater }, pool)
      assert.equal(pooled.riversRouted, 1)
      assert.deepEqual(pooled.discharge, alone.discharge)
    } finally {
      await pool.terminate()
    }
  })

  test('a pool worker that fails rejects the route and every later task', async () => {
    const { inputs } = readExpected(name)
    const pool = createWorkerPool(() => startWebWorker('./no-such-module.js'), 2)
    try {
      await assert.rejects(routeHydrograph(inputs, pool), /a pool worker failed/)
      assert.ok(pool.isBroken())
      await assert.rejects(pool.run({ kind: 'readChunkCells' }), /a pool worker failed/)
    } finally {
      await pool.terminate()
    }
  })

  test('the route worker answers with the hydrograph, or with the error', async () => {
    const { expected, inputs } = readExpected(name)
    const worker = startWebWorker('../src/route-worker.js')
    const answer = message => new Promise(resolve => {
      worker.onmessage = ({ data }) => resolve(data)
      worker.postMessage(message)
    })
    try {
      const { routed } = await answer(inputs)
      assert.equal(routed.riverId, expected.outlet_river_id)
      assertSameHydrograph(routed.discharge, expected.hydrographs[expected.outlet_river_id])
      const { error } = await answer({ ...inputs, riverId: 1 })
      assert.match(error, /has no river 1$/)
    } finally {
      await worker.terminate()
    }
  })
})

describe('kernels', () => {
  const [name] = expectedFiles

  test('the WebAssembly kernel routes what the JavaScript kernel does', async () => {
    const { expected, inputs } = readExpected(name)
    const { network, runoffByCell, nSteps } = await prepareRouting(inputs)
    const inJavaScript = javascript.routeRivers(network, runoffByCell, nSteps)
    assertSameHydrograph(wasm.routeRivers(network, runoffByCell, nSteps), inJavaScript)
    const clamped = inJavaScript.map(discharge => Math.max(discharge, 0))
    assertSameHydrograph(clamped, expected.hydrographs[expected.outlet_river_id])
  })

  test('the WebAssembly kernel names what is wrong with a network it refuses', async () => {
    const { expected, inputs } = readExpected(name)
    const riverId = Number(Object.keys(expected.hydrographs).find(river => Number(river) !== expected.outlet_river_id))
    const { network, runoffByCell, nSteps } = await prepareRouting({ ...inputs, riverId })
    const drainsIntoItself = { ...network, downstreamPositions: network.downstreamPositions.with(0, 0) }
    assert.throws(() => wasm.routeRivers(drainsIntoItself, runoffByCell, nSteps), /drains into itself or into a river/)
    const weightStart = network.weightStart.with(1, network.weightStart[0]) // the first river left with no weights
    assert.throws(() => wasm.routeRivers({ ...network, weightStart }, runoffByCell, nSteps), /a river has no weights/)
    const weightCell = network.weightCell.with(0, runoffByCell.length / nSteps) // one past the last cell read
    assert.throws(() => wasm.routeRivers({ ...network, weightCell }, runoffByCell, nSteps), /reads a cell outside/)
  })

  test('the time-step kernels route what the river-first kernels do', async () => {
    const { expected, inputs } = readExpected(name)
    const { network, runoffByCell, nSteps } = await prepareRouting(inputs)
    const riverFirst = wasm.routeRivers(network, runoffByCell, nSteps)
    for (const route of [javascript.routeRiversByTimeStep, wasm.routeRiversByTimeStep]) {
      const timeStepFirst = route(network, runoffByCell, nSteps)
      assertSameHydrograph(timeStepFirst, riverFirst)
      const clamped = timeStepFirst.map(discharge => Math.max(discharge, 0))
      assertSameHydrograph(clamped, expected.hydrographs[expected.outlet_river_id])
    }
  })

  test("the time-step kernels hand every river's discharge, in routing order, to onStep after each step", async () => {
    const { expected, inputs } = readExpected(name)
    const riverId = Number(Object.keys(expected.hydrographs).find(river => Number(river) !== expected.outlet_river_id))
    const { network, runoffByCell, nSteps } = await prepareRouting({ ...inputs, riverId })
    const nRivers = network.downstreamPositions.length
    const lastSteps = {}
    const kernels = [['javascript', javascript.routeRiversByTimeStep], ['wasm', wasm.routeRiversByTimeStep]]
    for (const [kernel, route] of kernels) {
      let calls = 0
      const handedOutlet = new Float64Array(nSteps)
      const series = route(network, runoffByCell, nSteps, (step, discharge) => {
        assert.equal(step, calls++)
        assert.equal(discharge.length, nRivers)
        handedOutlet[step] = discharge[nRivers - 1] // the target, the last river in routing order
        if (step === nSteps - 1) lastSteps[kernel] = Float64Array.from(discharge)
      })
      assert.equal(calls, nSteps)
      assert.deepEqual(handedOutlet, Float64Array.from(series))
    }
    assertSameHydrograph(lastSteps.wasm, lastSteps.javascript) // every river at the last step, back in routing order
  })

  test('routing in windows of steps routes what routing every step at once does', async () => {
    const { inputs } = readExpected(name)
    const { network, runoffByCell, nSteps } = await prepareRouting(inputs)
    const allAtOnce = wasm.routeRivers(network, runoffByCell, nSteps)
    const longer = 8 * Math.ceil(nSteps / 8) + 8
    for (const stepsPerWindow of [64, longer]) { // windows the steps are not a whole number of, and one longer
      assertSameHydrograph(wasm.routeRiversByTimeWindow(network, runoffByCell, nSteps, stepsPerWindow), allAtOnce)
    }
    const window = 12 // not a whole number of 8 steps
    const refused = /the routing kernel refused the network: a window is not a whole number of blocks of 8 steps/
    assert.throws(() => wasm.routeRiversByTimeWindow(network, runoffByCell, nSteps, window), refused)
  })

  test("routing in windows hands every river's discharge in each window, in routing order, to onWindow", async () => {
    const { expected, inputs } = readExpected(name)
    const riverId = Number(Object.keys(expected.hydrographs).find(river => Number(river) !== expected.outlet_river_id))
    const { network, runoffByCell, nSteps } = await prepareRouting({ ...inputs, riverId })
    const nRivers = network.downstreamPositions.length
    const stepsPerWindow = 64
    let lastStep
    wasm.routeRiversByTimeStep(network, runoffByCell, nSteps, (step, discharge) => {
      if (step === nSteps - 1) lastStep = Float64Array.from(discharge)
    })
    const firstSteps = []
    const handedOutlet = new Float64Array(nSteps)
    const lastWindowStep = new Float64Array(nRivers)
    const series = wasm.routeRiversByTimeWindow(network, runoffByCell, nSteps, stepsPerWindow, (firstStep, discharge) => {
      firstSteps.push(firstStep)
      assert.equal(discharge.length, nRivers * stepsPerWindow)
      const nWindowSteps = Math.min(stepsPerWindow, nSteps - firstStep)
      for (let step = 0; step < nWindowSteps; step++) {
        handedOutlet[firstStep + step] = discharge[(nRivers - 1) * stepsPerWindow + step] // the target, the last river
      }
      for (let river = 0; river < nRivers && firstStep + nWindowSteps === nSteps; river++) {
        lastWindowStep[river] = discharge[river * stepsPerWindow + nWindowSteps - 1]
      }
    })
    const nWindows = Math.ceil(nSteps / stepsPerWindow)
    assert.deepEqual(firstSteps, Array.from({ length: nWindows }, (_, window) => window * stepsPerWindow))
    assert.deepEqual(handedOutlet, Float64Array.from(series))
    assertSameHydrograph(lastWindowStep, lastStep) // every river at the last step, against the time-step kernel
  })
})
