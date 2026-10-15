/**
 * Route the test data over HTTP from a vite dev server the tests start: the network file and grid weights of region
 * 7020014250, the Columbia, in data/routing, and the ERA5 runoff of 1940 and 1941 in data/forcings, and check that
 * river-route-web reads its inputs and routes them the same in one thread, on workers, window by window, and live. They
 * do not compare kernel.js and prepare.js with river-route's Python.
 */
import assert from 'node:assert/strict'
import { readdirSync, statSync } from 'node:fs'
import { after, before, describe, test } from 'node:test'
import { Worker as NodeWorker } from 'node:worker_threads'
import * as wasm from '../src/kernel.js'
import { createServer } from 'vite'
import { classifyDischarge } from '../src/discharge-classes.js'
import { createLiveEngine } from '../src/live-engine.js'
import { prepareRegion, prepareRouting, readRoutingParameters, routeHydrograph } from '../src/routing.js'
import { checkOneYear, openRunoff } from '../src/runoff.js'
import { createWorkerPool } from '../src/worker-pool.js'

const TOLERANCE = 10e-4 // as in river-route's tests: answers may differ by this share of the river's largest value
const RIVER_ROUTE_WEB_DIRECTORY = new URL('..', import.meta.url).pathname
const ROUTING_DIRECTORY = new URL('../data/routing/', import.meta.url)
const TESTED_REGION = 'region=7020014250'
const TESTED_RIVER = 720184033 // the Willamette where it joins the Columbia at Portland: 1,390 rivers
const WILLAMETTE_RIVERS = 1390
const STEP_SECONDS = 3600 // live routing's step, an hour

let server
let dataUrl

before(async () => {
  server = await createServer({ root: RIVER_ROUTE_WEB_DIRECTORY, server: { port: 0 }, logLevel: 'error' })
  await server.listen()
  dataUrl = new URL('data/', server.resolvedUrls.local[0])
})

after(() => server.close())

/** The url of a year's runoff array. */
function runoffUrl(year) {
  return new URL(`forcings/era5/${year}.zarr/ro`, dataUrl).href
}

/** The inputs of the tested region and the runoff of 1940. */
function testedInputs() {
  const region = TESTED_REGION.split('=')[1]
  return {
    routingParametersUrl: new URL(`routing/${TESTED_REGION}/network.parquet`, dataUrl).href,
    gridWeightsUrl: new URL(`routing/${TESTED_REGION}/gridweights_ERA5_${region}.parquet`, dataUrl).href,
    runoffUrls: [runoffUrl(1940)],
  }
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

describe(TESTED_REGION, () => {
  test('routes the outlet that drains the largest area', async () => {
    const routed = await routeHydrograph(testedInputs())
    assert.equal(routed.discharge.length, routed.times.length)
    assert.ok(routed.discharge.some(discharge => discharge > 0), 'the outlet carried no water')
  })

  test('routes a river and only the rivers upstream of it, each in one or more sub-reaches', async () => {
    const routed = await routeHydrograph({ ...testedInputs(), riverId: TESTED_RIVER })
    assert.equal(routed.riverId, TESTED_RIVER)
    assert.equal(routed.riversRouted, WILLAMETTE_RIVERS)
    const { subReachStarts, outlets } = routed.network
    assert.equal(subReachStarts.length, WILLAMETTE_RIVERS + 1)
    assert.ok(subReachStarts[WILLAMETTE_RIVERS] >= WILLAMETTE_RIVERS, 'fewer sub-reaches than rivers')
    assert.deepEqual(outlets, Int32Array.of(WILLAMETTE_RIVERS - 1)) // the target, the last river
  })

  test('names the river that is not in the network file', async () => {
    await assert.rejects(routeHydrograph({ ...testedInputs(), riverId: 1 }), /has no river 1$/)
  })

  test('names the input that cannot be read', async () => {
    const inputs = testedInputs()
    const routingParametersUrl = `${inputs.routingParametersUrl}.missing`
    await assert.rejects(routeHydrograph({ ...inputs, routingParametersUrl }), /\.missing answered 404/)
  })

  test("reads a period's runoff as those steps of all of it", async () => {
    const inputs = testedInputs()
    const all = await prepareRouting(inputs)
    const [first, stop] = [1000, 1744] // a month of hours
    const period = await prepareRouting({ ...inputs, period: { start: all.times[first], stop: all.times[stop] } })
    assert.deepEqual(period.times, all.times.slice(first, stop))
    assert.deepEqual(period.riverIds, all.riverIds)
    assertSameRows(period.runoffByCell, period.nSteps, all.runoffByCell, all.nSteps, first)
  })

  test('reads a period across two runoff arrays, the second going on from the first', async () => {
    const inputs = testedInputs()
    const nextUrl = runoffUrl(1941)
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

  test('reads runoff one zarr a year, refusing an array that holds more', async () => {
    const twoYears = await openRunoff([runoffUrl(1940), runoffUrl(1941)])
    const refused = /both holds runoff from \d+ to \d+; runoff is read one zarr a year$/
    assert.throws(() => checkOneYear(twoYears.times, 'both'), refused) // the steps of one array of both years
  })

  test('names runoff arrays that do not go on from one another, and a period with no runoff', async () => {
    const inputs = testedInputs()
    const runoffUrls = [...inputs.runoffUrls, ...inputs.runoffUrls]
    await assert.rejects(prepareRouting({ ...inputs, runoffUrls }), /does not start the step after .* ends$/)
    const period = { start: Date.UTC(1800, 0, 1) / 1000, stop: Date.UTC(1800, 0, 2) / 1000 }
    await assert.rejects(prepareRouting({ ...inputs, period }), /have no runoff from 1800-01-01T00:00:00.000Z/)
    const backwards = { start: period.stop, stop: period.start }
    await assert.rejects(prepareRouting({ ...inputs, period: backwards }), /a period must start before it stops/)
  })

  test('the data server answers a byte range of a file, and refuses one it cannot serve', async () => {
    const url = testedInputs().routingParametersUrl
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

/** Route the windows of ``stepsPerWindow`` steps from ``firstStep`` up to ``stop`` with a stepper of startWindows. */
function routeWindows(stepper, runoff, stepsPerWindow, firstStep, stop) {
  for (let first = firstStep; first < stop; first += stepsPerWindow) {
    const steps = Math.min(stepsPerWindow, stop - first)
    stepper.copyRunoff(runoff, first, steps)
    stepper.route(steps)
  }
}

/** Every river's value at ``step`` of a series of ``nSteps`` a river. */
function valuesAtStep(series, nSteps, step) {
  return Float32Array.from({ length: series.length / nSteps }, (_, river) => series[river * nSteps + step])
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
  test('a pool routes what this thread does, its workers reading the runoff and routing regions', async () => {
    const inputs = testedInputs()
    const alone = await routeHydrograph(inputs)
    const pool = createWorkerPool(() => startWebWorker('../src/pool-worker.js'), 4)
    try {
      const routed = await routeHydrograph(inputs, pool)
      assert.equal(routed.riverId, alone.riverId)
      assertSameHydrograph(routed.discharge, alone.discharge)
    } finally {
      await pool.terminate()
    }
  })

  test('a pool routes a river with nothing upstream the same as this thread', async () => {
    const inputs = testedInputs()
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
    const pool = createWorkerPool(() => startWebWorker('./no-such-module.js'), 2)
    try {
      await assert.rejects(routeHydrograph(testedInputs(), pool), /a pool worker failed/)
      assert.ok(pool.isBroken())
      await assert.rejects(pool.run({ kind: 'readChunkCells' }), /a pool worker failed/)
    } finally {
      await pool.terminate()
    }
  })

  test('the route worker answers with the hydrograph, or with the error', async () => {
    const inputs = { ...testedInputs(), riverId: TESTED_RIVER }
    const alone = await routeHydrograph(inputs)
    const worker = startWebWorker('../src/route-worker.js')
    const answer = message => new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => resolve(data)
      worker.onerror = event => reject(new Error(`the route worker failed: ${event.message}`))
      worker.postMessage(message)
    })
    try {
      const { routed } = await answer(inputs)
      assert.equal(routed.riverId, TESTED_RIVER)
      assert.deepEqual(routed.riverIds, alone.riverIds)
      assertSameHydrograph(routed.discharge, alone.discharge)
      const { error } = await answer({ ...inputs, riverId: 1 })
      assert.match(error, /has no river 1$/)
    } finally {
      await worker.terminate()
    }
  })
})

describe('kernels', () => {
  test('the kernel names what is wrong with a network it refuses', async () => {
    const { network, runoffByCell, nSteps } = await prepareRouting({ ...testedInputs(), riverId: TESTED_RIVER })
    const runoff = { depth: runoffByCell, nSteps }
    const lastEntry = network.inflowRivers.length - 1 // of the target, the last river with inflow rivers
    const ownInflow = { ...network, inflowRivers: network.inflowRivers.with(lastEntry, network.outlets[0]) }
    assert.throws(() => wasm.routeRivers(ownInflow, runoff), /a river drains into a river before it in routing order/)
    const weightCells = network.weightCells.with(0, runoffByCell.length / nSteps) // one past the last cell read
    assert.throws(() => wasm.routeRivers({ ...network, weightCells }, runoff), /a weight reads a cell outside/)
    const blocks = { starts: [5], stops: [3] }
    assert.throws(() => wasm.routeRivers(network, runoff, { blocks }), /blocks of rivers are not in routing order/)
  })

  test('routing in windows of any length routes what routing every step at once does, keeping the rivers asked for',
    async () => {
      const { network, runoffByCell, nSteps } = await prepareRouting(testedInputs())
      const runoff = { depth: runoffByCell, nSteps }
      const lastRiver = network.subReachStarts.length - 2
      const allAtOnce = wasm.routeRivers(network, runoff, { keep: [lastRiver, 0], stepsPerWindow: nSteps })
      for (const stepsPerWindow of [64, 12, nSteps + 8]) { // whole eights of steps, not, and longer than the run
        const kept = wasm.routeRivers(network, runoff, { keep: [lastRiver, 0], stepsPerWindow })
        assertSameHydrograph(kept.subarray(0, nSteps), allAtOnce.subarray(0, nSteps))
        assertSameHydrograph(kept.subarray(nSteps), allAtOnce.subarray(nSteps))
      }
      assert.deepEqual(wasm.routeRivers(network, runoff), allAtOnce.subarray(0, nSteps)) // the outlet, by default
      assert.throws(() => wasm.routeRivers(network, runoff, { stepsPerWindow: 0 }), /a window is a whole number/)
    })

  test('a window stepper routes what routeRivers does, starts over, and stops when overwritten', async () => {
    const { network, runoffByCell, nSteps } = await prepareRouting({ ...testedInputs(), riverId: TESTED_RIVER })
    const runoff = { depth: runoffByCell, nSteps }
    const stepsPerWindow = 64
    const everyRiver = Int32Array.from({ length: WILLAMETTE_RIVERS }, (_, river) => river)
    const series = wasm.routeRivers(network, runoff, { keep: everyRiver, stepsPerWindow })
    const nCells = runoffByCell.length / nSteps
    const stepper = wasm.startWindows(network, { nCells, stepsPerWindow })
    const atStep = new Float32Array(WILLAMETTE_RIVERS)
    routeWindows(stepper, runoff, stepsPerWindow, 0, 128)
    assert.deepEqual(stepper.dischargeAt(63, atStep), valuesAtStep(series, nSteps, 127)) // the second window's last
    const targetRow = (WILLAMETTE_RIVERS - 1) * nSteps
    assert.deepEqual(stepper.riverSeries(WILLAMETTE_RIVERS - 1), series.subarray(targetRow + 64, targetRow + 128))
    assert.throws(() => stepper.dischargeAt(64, atStep), /has 64 steps, not a step 64/)
    stepper.setChannelState(new Float32Array(stepper.channelState().length)) // from no discharge again
    routeWindows(stepper, runoff, stepsPerWindow, 0, 64)
    assert.deepEqual(stepper.dischargeAt(10, atStep), valuesAtStep(series, nSteps, 10))
    assert.throws(() => stepper.route(stepsPerWindow + 1), /a window routes 1 to 64 steps, not 65/)
    wasm.routeRivers(network, runoff)
    assert.throws(() => stepper.route(1), /has routed another network since this one started/)
  })

  test('a window stepper carries its channel state into another, which routes on exactly as the first would',
    async () => {
      const { network, runoffByCell, nSteps } = await prepareRouting({ ...testedInputs(), riverId: TESTED_RIVER })
      const runoff = { depth: runoffByCell, nSteps }
      const options = { nCells: runoffByCell.length / nSteps, stepsPerWindow: 50 }
      const atStep = new Float32Array(WILLAMETTE_RIVERS)
      const unbroken = wasm.startWindows(network, options)
      routeWindows(unbroken, runoff, 50, 0, 150)
      const unbrokenDischarge = Float32Array.from(unbroken.dischargeAt(49, atStep))
      const carrying = wasm.startWindows(network, options)
      routeWindows(carrying, runoff, 50, 0, 100)
      const carried = Float32Array.from(carrying.channelState())
      const carrier = wasm.startWindows(network, options)
      carrier.setChannelState(carried)
      routeWindows(carrier, runoff, 50, 100, 150)
      assert.deepEqual(carrier.dischargeAt(49, atStep), unbrokenDischarge)
      assert.throws(() => carrier.setChannelState(carried.subarray(1)), /cannot set/)
    })
})

test('discharge is classed perTenfold to each tenfold above the lowest, from 0 up to the top class', () => {
  const classing = { lowest: 0.1, perTenfold: 5, top: 30 }
  const discharge = Float32Array.of(0, 0.1, 1, 10, 1e5, 1e7)
  const classes = classifyDischarge(discharge, classing, new Float32Array(discharge.length))
  assert.deepEqual(Array.from(classes, value => Math.round(value * 1e4) / 1e4), [0, 0, 5, 10, 30, 30])
  const refused = /discharge classes need a lowest discharge, classes a tenfold, and a top class above 0/
  assert.throws(() => classifyDischarge(discharge, { ...classing, perTenfold: 0 }, classes), refused)
})

describe('live', () => {
  /** The tested region, as prepareRegion reads it, and its runoff grid's cells a row. */
  async function readTestedRegion() {
    const inputs = testedInputs()
    const region = await prepareRegion(inputs, STEP_SECONDS)
    const nX = (await openRunoff(inputs.runoffUrls)).array.shape[2]
    return { inputs, region, nX }
  }

  /** The keys of the cells of the region's first ``nWeights`` weights. */
  function cellsOfWeights({ weightCellY, weightCellX }, nX, nWeights) {
    return [...new Set(Array.from({ length: nWeights }, (_, weight) => weightCellY[weight] * nX + weightCellX[weight]))]
  }

  /**
   * Every river's discharge at the end of each of ``nSteps`` steps of the region routed by routeRivers, from the runoff
   * ``depthOf(cellKey, step)`` gives each of its cells.
   */
  function routeRegionRun(region, nX, nSteps, depthOf) {
    const cellOfKey = new Map()
    const weightCells = Int32Array.from(region.weightCellY, (y, weight) => {
      const cellKey = y * nX + region.weightCellX[weight]
      if (!cellOfKey.has(cellKey)) cellOfKey.set(cellKey, cellOfKey.size)
      return cellOfKey.get(cellKey)
    })
    const depth = new Float32Array(cellOfKey.size * nSteps)
    for (const [cellKey, cell] of cellOfKey) {
      for (let step = 0; step < nSteps; step++) depth[cell * nSteps + step] = depthOf(cellKey, step)
    }
    const keep = Int32Array.from(region.riverIds, (_, river) => river)
    return wasm.routeRivers({ ...region.network, weightCells }, { depth, nSteps }, { keep })
  }

  test('a live engine routes the painted cells as a run of their runoff routes, until they are erased', async () => {
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
    const paintedCells = new Set(cellKeys)
    const paintedDepth = (cellKey, step) => (paintedCells.has(cellKey) && step < 24 ? depth : 0)
    const series = routeRegionRun(region, nX, 48, paintedDepth)
    assertSameHydrograph(painted, valuesAtStep(series, 48, 23))
    assertSameHydrograph(erased, valuesAtStep(series, 48, 47))
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
    // both sets pulsed the first step, the cells under the brush the next two, and none the last two
    const forced = [new Set(cells), new Set(underBrush), new Set(underBrush), new Set(), new Set()]
    const series = routeRegionRun(region, nX, 5, (cellKey, step) => (forced[step].has(cellKey) ? depth : 0))
    assertSameHydrograph(pulsed, valuesAtStep(series, 5, 4))
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
    const { region, nX } = await readTestedRegion()
    const others = readdirSync(ROUTING_DIRECTORY).filter(entry => {
      return entry.startsWith('region=') && entry !== TESTED_REGION
    })
    assert.ok(others.length > 0, `no region beside ${TESTED_REGION} in ${ROUTING_DIRECTORY.pathname}`)
    const size = entry => statSync(new URL(`${entry}/network.parquet`, ROUTING_DIRECTORY)).size
    const smallest = others.reduce((least, entry) => (size(entry) < size(least) ? entry : least))
    const weightsFile = readdirSync(new URL(`${smallest}/`, ROUTING_DIRECTORY)).find(file => {
      return file.startsWith('gridweights') && file.endsWith('.parquet')
    })
    const other = await prepareRegion({
      routingParametersUrl: new URL(`routing/${smallest}/network.parquet`, dataUrl).href,
      gridWeightsUrl: new URL(`routing/${smallest}/${weightsFile}`, dataUrl).href,
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
    alone.route(48) // routed as the joined engine's windows are
    alone.route(48)
    assert.deepEqual(tested, Float32Array.from(alone.discharge()))
    alone.drain()
    assert.ok(alone.discharge().every(discharge => discharge === 0), 'drained rivers still hold water')
  })
})
