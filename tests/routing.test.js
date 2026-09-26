/**
 * Route the test data over HTTP from a vite dev server the tests start, and require each hydrograph to match the one
 * river-route routes from the same inputs, which tests/prepare_test_data.py records in data/expected/.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { Worker as NodeWorker } from 'node:worker_threads'
import { createServer } from 'vite'
import * as javascript from '../src/muskingum.js'
import { createLiveEngine } from '../src/live-engine.js'
import * as wasm from '../src/muskingum-wasm.js'
import { prepareRegion, prepareRouting, readRoutingParameters, routeHydrograph } from '../src/routing.js'
import { openRunoff } from '../src/runoff.js'
import { createWorkerPool } from '../src/worker-pool.js'

const TOLERANCE = 10e-4 // as in river-route's tests: answers may differ by this share of the river's largest value
const JSRR_DIRECTORY = new URL('..', import.meta.url).pathname
const EXPECTED_DIRECTORY = new URL('../data/expected/', import.meta.url)
const HYDROGRAPHY_DIRECTORY = new URL('../data/hydrography/', import.meta.url)
const STEP_SECONDS = 3600 // live routing's step, an hour
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
    runoffUrls: [new URL(expected.runoff, dataUrl).href],
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

    test("reads a period's runoff as those steps of all of it", async () => {
      const { inputs } = readExpected(name)
      const all = await prepareRouting(inputs)
      const [first, stop] = [1000, 1744] // a month of hours
      const period = await prepareRouting({ ...inputs, period: { start: all.times[first], stop: all.times[stop] } })
      assert.deepEqual(period.times, all.times.slice(first, stop))
      assert.deepEqual(period.riverIds, all.riverIds)
      assertSameRows(period.runoffByCell, period.nSteps, all.runoffByCell, all.nSteps, first)
    })

    test('reads a period across two runoff arrays, the second going on from the first', async () => {
      const { expected, inputs } = readExpected(name)
      assert.ok(expected.more_runoff?.length > 0, 'no runoff beside the routed; run prepare_test_data.py --more-runoff')
      const nextUrl = new URL(expected.more_runoff[0], dataUrl).href
      const [before, after] = await Promise.all([inputs.runoffUrls, [nextUrl]].map(runoffUrls => {
        return prepareRouting({ ...inputs, runoffUrls })
      }))
      const period = { start: before.times[before.nSteps - 24], stop: after.times[24] } // a day on each side
      const across = await prepareRouting({ ...inputs, runoffUrls: [...inputs.runoffUrls, nextUrl], period })
      assert.deepEqual(across.times, Float64Array.of(...before.times.slice(-24), ...after.times.slice(0, 24)))
      const acrossBefore = sliceRows(across.runoffByCell, across.nSteps, 0, 24)
      const acrossAfter = sliceRows(across.runoffByCell, across.nSteps, 24, 48)
      assertSameRows(acrossBefore, 24, before.runoffByCell, before.nSteps, before.nSteps - 24)
      assertSameRows(acrossAfter, 24, after.runoffByCell, after.nSteps, 0)
    })

    test('names runoff arrays that do not go on from one another, and a period with no runoff', async () => {
      const { inputs } = readExpected(name)
      const runoffUrls = [...inputs.runoffUrls, ...inputs.runoffUrls]
      await assert.rejects(prepareRouting({ ...inputs, runoffUrls }), /does not start the step after .* ends$/)
      const period = { start: Date.UTC(1800, 0, 1) / 1000, stop: Date.UTC(1800, 0, 2) / 1000 }
      await assert.rejects(prepareRouting({ ...inputs, period }), /have no runoff from 1800-01-01T00:00:00.000Z/)
      const backwards = { start: period.stop, stop: period.start }
      await assert.rejects(prepareRouting({ ...inputs, period: backwards }), /a period must start before it stops/)
    })

    test('the data server answers a byte range of a file, and refuses one it cannot serve', async () => {
      const url = new URL(`expected/${name}`, dataUrl)
      const size = (await (await fetch(url)).arrayBuffer()).byteLength
      const partial = await fetch(url, { headers: { range: 'bytes=5-14' } })
      assert.equal(partial.status, 206)
      assert.equal(partial.headers.get('content-range'), `bytes 5-14/${size}`)
      assert.equal((await partial.arrayBuffer()).byteLength, 10)
      const refused = await fetch(url, { headers: { range: 'bytes=14-5' } })
      assert.equal(refused.status, 416)
      assert.equal(refused.headers.get('content-range'), `bytes */${size}`)
    })
  })
}

/** Fill a live stepper's forcing row with each river's runoff forcing at ``step``, summed from its weights' cells. */
function forceLiveStep(live, { weightStart, weightCell, weightForcing }, runoffByCell, nSteps, step) {
  for (let river = 0; river < weightStart.length - 1; river++) {
    let forcing = 0
    for (let weight = weightStart[river]; weight < weightStart[river + 1]; weight++) {
      forcing += weightForcing[weight] * runoffByCell[weightCell[weight] * nSteps + step]
    }
    live.forcing[live.levelPositions[river]] = forcing
  }
}

/** The steps from ``first`` up to ``stop`` of each row of a (row, step) array with rows of ``nSteps``. */
function sliceRows(rows, nSteps, first, stop) {
  const sliced = new Float32Array((rows.length / nSteps) * (stop - first))
  for (let row = 0; row < rows.length / nSteps; row++) {
    sliced.set(rows.subarray(row * nSteps + first, row * nSteps + stop), row * (stop - first))
  }
  return sliced
}

/** Require each row of ``actual``, rows of ``nSteps``, to be the same steps of ``desired``'s rows from ``first``. */
function assertSameRows(actual, nSteps, desired, nDesiredSteps, first) {
  assert.equal(actual.length / nSteps, desired.length / nDesiredSteps, 'the arrays have different counts of rows')
  assert.deepEqual(actual, sliceRows(desired, nDesiredSteps, first, first + nSteps))
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

  test('a stepper routes a step at a time what routeRiversByTimeStep does, starts over, and stops when overwritten',
    async () => {
      const { expected, inputs } = readExpected(name)
      const riverId = Number(Object.keys(expected.hydrographs).find(river => {
        return Number(river) !== expected.outlet_river_id
      }))
      const { network, runoffByCell, nSteps } = await prepareRouting({ ...inputs, riverId })
      const handed = new Map()
      const series = wasm.routeRiversByTimeStep(network, runoffByCell, nSteps, (step, discharge) => {
        if (step === 99 || step === 199) handed.set(step, Float32Array.from(discharge))
      })
      const stepper = wasm.startTimeSteps(network, runoffByCell, nSteps)
      assert.equal(stepper.advance(100), 100)
      assert.deepEqual(Float32Array.from(stepper.discharge()), handed.get(99))
      assert.equal(stepper.advance(100), 200)
      assert.deepEqual(Float32Array.from(stepper.discharge()), handed.get(199))
      assert.throws(() => stepper.outletSeries(), new RegExp(`series have ${nSteps - 200} steps left to route`))
      stepper.restart()
      assert.equal(stepper.advance(100), 100)
      assert.deepEqual(Float32Array.from(stepper.discharge()), handed.get(99))
      assert.throws(() => stepper.advance(0.5), /advances a whole number of steps, not 0.5/)
      assert.equal(stepper.advance(2 * nSteps), nSteps)
      assert.deepEqual(stepper.outletSeries(), series)
      wasm.routeRivers(network, runoffByCell, nSteps)
      assert.throws(() => stepper.advance(1), /has routed another network since this one started/)
    })

  test("a stepper classes each river's discharge by tenfolds, to within the kernel's logarithm", async () => {
    const { inputs } = readExpected(name)
    const { network, runoffByCell, nSteps } = await prepareRouting(inputs)
    const stepper = wasm.startTimeSteps(network, runoffByCell, nSteps)
    const classing = { lowest: 0.01, perTenfold: 8, top: 48 }
    const bound = 2 * 0.0077 * Math.log10(2) * classing.perTenfold // twice the error of the kernel's base 2 logarithm
    let worst = 0
    for (const steps of [24, 1976, nSteps]) { // a day, a quarter of a year, and every step
      stepper.advance(steps)
      const discharge = Float32Array.from(stepper.discharge())
      const classes = stepper.dischargeClasses(classing)
      discharge.forEach((value, river) => {
        const tenfolds = Math.log10(Math.max(value, classing.lowest) / classing.lowest)
        const exact = Math.min(Math.max(tenfolds * classing.perTenfold, 0), classing.top)
        worst = Math.max(worst, Math.abs(classes[river] - exact))
      })
    }
    assert.ok(worst <= bound, `a class is off by ${worst}, more than ${bound}`)
    const refused = /discharge classes need a lowest discharge, classes a tenfold, and a top class above 0/
    assert.throws(() => stepper.dischargeClasses({ ...classing, perTenfold: 0 }), refused)
  })

  test('a live stepper, given each step its runoff forcing, routes what the time-step kernel does', async () => {
    const { expected, inputs } = readExpected(name)
    const riverId = Number(Object.keys(expected.hydrographs).find(river => Number(river) !== expected.outlet_river_id))
    const { network, runoffByCell, nSteps } = await prepareRouting({ ...inputs, riverId })
    const handed = new Map()
    wasm.routeRiversByTimeStep(network, runoffByCell, nSteps, (step, discharge) => {
      if (step === 99 || step === 999) handed.set(step, Float32Array.from(discharge))
    })
    const live = wasm.startLiveSteps(network)
    for (let step = 0; step <= 999; step++) {
      forceLiveStep(live, network, runoffByCell, nSteps, step)
      live.route()
      if (handed.has(step)) assertSameHydrograph(live.discharge(), handed.get(step))
    }
  })

  test('a live stepper carries its discharge into another, which routes on exactly as the first would', async () => {
    const { expected, inputs } = readExpected(name)
    const riverId = Number(Object.keys(expected.hydrographs).find(river => Number(river) !== expected.outlet_river_id))
    const { network, runoffByCell, nSteps } = await prepareRouting({ ...inputs, riverId })
    const routeSteps = (live, first, stop) => {
      for (let step = first; step < stop; step++) {
        forceLiveStep(live, network, runoffByCell, nSteps, step)
        live.route()
      }
      return Float32Array.from(live.discharge())
    }
    const unbroken = routeSteps(wasm.startLiveSteps(network), 0, 150)
    const carried = routeSteps(wasm.startLiveSteps(network), 0, 100)
    const carrier = wasm.startLiveSteps(network)
    carrier.setDischarge(carried)
    assert.deepEqual(routeSteps(carrier, 100, 150), unbroken)
    assert.throws(() => carrier.setDischarge(carried.subarray(1)), /cannot set/)
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
    const handWindow = (firstStep, discharge) => {
      firstSteps.push(firstStep)
      assert.equal(discharge.length, nRivers * stepsPerWindow)
      const nWindowSteps = Math.min(stepsPerWindow, nSteps - firstStep)
      for (let step = 0; step < nWindowSteps; step++) {
        handedOutlet[firstStep + step] = discharge[(nRivers - 1) * stepsPerWindow + step] // the target, the last river
      }
      for (let river = 0; river < nRivers && firstStep + nWindowSteps === nSteps; river++) {
        lastWindowStep[river] = discharge[river * stepsPerWindow + nWindowSteps - 1]
      }
    }
    const series = wasm.routeRiversByTimeWindow(network, runoffByCell, nSteps, stepsPerWindow, handWindow)
    const nWindows = Math.ceil(nSteps / stepsPerWindow)
    assert.deepEqual(firstSteps, Array.from({ length: nWindows }, (_, window) => window * stepsPerWindow))
    assert.deepEqual(handedOutlet, Float64Array.from(series))
    assertSameHydrograph(lastWindowStep, lastStep) // every river at the last step, against the time-step kernel
  })
})

describe('live', () => {
  const [name] = expectedFiles

  /** The tested region, as prepareRegion reads it, and its runoff grid's cells a row. */
  async function readTestedRegion() {
    const { inputs } = readExpected(name)
    const region = await prepareRegion(inputs, STEP_SECONDS)
    const nX = (await openRunoff(inputs.runoffUrls)).array.shape[2]
    return { inputs, region, nX }
  }

  /** The keys of the cells of the region's first ``nWeights`` weights. */
  function cellsOfWeights({ weightCellY, weightCellX }, nX, nWeights) {
    return [...new Set(Array.from({ length: nWeights }, (_, weight) => weightCellY[weight] * nX + weightCellX[weight]))]
  }

  test('a live engine forces each river by the painted cells its catchment covers, until they are erased', async () => {
    const { region, nX } = await readTestedRegion()
    const cellKeys = cellsOfWeights(region, nX, 200)
    const depth = 0.005 // meters a step
    const engine = createLiveEngine(nX)
    engine.addRegion('tested', region)
    engine.setRunoff(cellKeys, depth)
    engine.route(24)
    const painted = Float32Array.from(engine.discharge())
    engine.setRunoff(cellKeys, 0)
    engine.route(24)
    const erased = Float32Array.from(engine.discharge())
    assert.equal(engine.sourceCells(), 0)
    assert.equal(engine.stepsRouted(), 48)
    // the same by hand: each weight whose cell is painted forcing its river with the depth
    const live = wasm.startLiveSteps(region)
    const paintedCells = new Set(cellKeys)
    for (let step = 0; step < 48; step++) {
      for (let weight = 0; weight < region.weightRiver.length && step < 24; weight++) {
        if (!paintedCells.has(region.weightCellY[weight] * nX + region.weightCellX[weight])) continue
        live.forcing[live.levelPositions[region.weightRiver[weight]]] += depth * region.weightForcing[weight]
      }
      live.route()
      if (step === 23) assertSameHydrograph(painted, live.discharge())
    }
    assertSameHydrograph(erased, live.discharge())
    assert.ok(painted.some(discharge => discharge > 0), 'the painted cells forced no river')
  })

  test('a live engine pulses the cells under the brush each step, and those it passed over once', async () => {
    const { region, nX } = await readTestedRegion()
    const cells = cellsOfWeights(region, nX, 400)
    const [underBrush, passedOver] = [cells.slice(0, 4), cells.slice(4)]
    const depth = 0.005 // meters a step
    const engine = createLiveEngine(nX)
    engine.addRegion('tested', region)
    engine.pulse(underBrush, passedOver, depth)
    engine.route(3)
    engine.pulse([], [], depth) // let go
    engine.route(2)
    const pulsed = Float32Array.from(engine.discharge())
    // the same by hand: both sets pulsed the first step, the cells under the brush the next two, and none the last two
    const live = wasm.startLiveSteps(region)
    const force = cellKeys => {
      for (let weight = 0; weight < region.weightRiver.length; weight++) {
        if (!cellKeys.has(region.weightCellY[weight] * nX + region.weightCellX[weight])) continue
        live.forcing[live.levelPositions[region.weightRiver[weight]]] += depth * region.weightForcing[weight]
      }
    }
    const forced = [new Set(cells), new Set(underBrush), new Set(underBrush), new Set(), new Set()]
    for (const cellKeys of forced) {
      force(cellKeys)
      live.route()
    }
    assertSameHydrograph(pulsed, live.discharge())
    assert.ok(pulsed.some(discharge => discharge > 0), 'the pulses forced no river')
  })

  test('the live worker routes painted runoff without end, handing the page only its newest frame', async () => {
    const { inputs, region, nX } = await readTestedRegion()
    const worker = startWebWorker('../src/live-worker.js')
    const received = []
    let held // a frame the page keeps, which stops the next
    worker.onmessage = ({ data }) => {
      if (data.kind !== 'frame') {
        received.push(data)
        return
      }
      received.push({ ...data, classes: Float32Array.from(data.classes) })
      if (held === undefined) worker.postMessage({ kind: 'frame', classes: data.classes }, [data.classes.buffer])
      else held = data.classes
    }
    const waitFor = async (predicate, what) => {
      for (let tries = 0; tries < 300; tries++) {
        const found = received.find(predicate)
        if (found !== undefined) return found
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      throw new Error(`the live worker sent no ${what}`)
    }
    try {
      worker.postMessage({ kind: 'start', nX, classes: { lowest: 0.1, perTenfold: 5, top: 30 } })
      worker.postMessage({ kind: 'rate', rate: 1000 })
      const { routingParametersUrl, gridWeightsUrl } = inputs
      worker.postMessage({ kind: 'region', id: 'tested', routingParametersUrl, gridWeightsUrl })
      const network = await waitFor(data => data.kind === 'network', 'network')
      assert.equal(network.riverIds.length, region.riverIds.length)
      const cellKeys = Int32Array.from(cellsOfWeights(region, nX, 200))
      worker.postMessage({ kind: 'runoff', cellKeys, depthMillimeters: 20 })
      const wet = await waitFor(data => data.kind === 'frame' && data.classes.some(value => value >= 1), 'frame of water')
      const { queueMs, routeMs, hours, classesMs, sentAt } = wet.timings
      assert.ok([queueMs, routeMs, hours, classesMs].every(value => value >= 0) && sentAt > 0, 'a frame lacks timings')
      held = null // keep the next frame
      await waitFor(() => held !== null, 'frame to keep')
      const framesBefore = received.filter(data => data.kind === 'frame').length
      await new Promise(resolve => setTimeout(resolve, 300))
      const framesAfter = received.filter(data => data.kind === 'frame').length
      assert.equal(framesAfter, framesBefore, 'a frame came while one was kept')
      worker.postMessage({ kind: 'clear' })
      worker.postMessage({ kind: 'drain' })
      const keptClasses = held
      held = undefined
      worker.postMessage({ kind: 'frame', classes: keptClasses }, [keptClasses.buffer])
      const drainedAfter = received.length
      await waitFor((data, index) => index >= drainedAfter && data.kind === 'frame'
        && data.classes.every(value => value === 0), 'drained frame')
      worker.postMessage({ kind: 'pulse', underBrush: cellKeys, passedOver: new Int32Array(0), depthMillimeters: 20 })
      const pulsedAfter = received.length
      await waitFor((data, index) => index >= pulsedAfter && data.kind === 'frame'
        && data.classes.some(value => value >= 1), 'frame of a pulse')
      worker.postMessage({ kind: 'sideways' })
      assert.match((await waitFor(data => data.kind === 'error', 'error')).message, /has no task sideways/)
    } finally {
      await worker.terminate()
    }
  })

  test('a region loaded into a live engine joins without disturbing the rivers already routing', async () => {
    const { inputs, region, nX } = await readTestedRegion()
    const testedRegion = new URL(inputs.routingParametersUrl).pathname.split('/').at(-2) // region=<id>
    const others = readdirSync(HYDROGRAPHY_DIRECTORY).filter(entry => {
      return entry.startsWith('region=') && entry !== testedRegion
    })
    assert.ok(others.length > 0, 'no region beside the tested; run prepare_test_data.py --page-region-dirs')
    const size = entry => statSync(new URL(`${entry}/routing.parquet`, HYDROGRAPHY_DIRECTORY)).size
    const smallest = others.reduce((least, entry) => (size(entry) < size(least) ? entry : least))
    const weightsFile = readdirSync(new URL(`${smallest}/`, HYDROGRAPHY_DIRECTORY)).find(file => {
      return file.startsWith('gridweights') && file.endsWith('.parquet')
    })
    const other = await prepareRegion({
      routingParametersUrl: new URL(`hydrography/${smallest}/routing.parquet`, dataUrl).href,
      gridWeightsUrl: new URL(`hydrography/${smallest}/${weightsFile}`, dataUrl).href,
    }, STEP_SECONDS)
    const cellKeys = cellsOfWeights(region, nX, 200)
    const joined = createLiveEngine(nX)
    joined.addRegion('tested', region)
    joined.setRunoff(cellKeys, 0.005)
    joined.route(48)
    joined.addRegion('other', other)
    const joinedRegions = joined.regions().map(({ id, first }) => [id, first])
    assert.deepEqual(joinedRegions, [['tested', 0], ['other', region.riverIds.length]])
    joined.route(48)
    const tested = Float32Array.from(joined.discharge().subarray(0, region.riverIds.length))
    const alone = createLiveEngine(nX)
    alone.addRegion('tested', region)
    alone.setRunoff(cellKeys, 0.005)
    alone.route(96)
    assert.deepEqual(tested, Float32Array.from(alone.discharge()))
    alone.drain()
    assert.ok(alone.discharge().every(discharge => discharge === 0), 'drained rivers still hold water')
  })
})
