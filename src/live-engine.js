/**
 * Live routing: every river of the regions loaded, routed without end a window of steps at a time, forced by runoff
 * given to grid cells two ways. A source gives its cell a depth every step until it is erased; a pulse gives its depth
 * to the cells under the brush every step it stays over them, and once to each cell it passed over since the last
 * step. The regions' rivers make one network, each region's after the last's, so that a region loaded later joins
 * without disturbing the rivers already routing: every sub-reach keeps its discharge. A gauge records its river's
 * discharge every step, keeping only the last GAUGE_STEPS, so that its history never grows past them.
 */
import { startWindows } from './kernel.js'
import { classifyDischarge } from './discharge-classes.js'

export const GAUGE_STEPS = 3600 // the steps of discharge each gauge keeps, the last 30 days of hours
export const MOST_GAUGES = 6
const STEPS_PER_WINDOW = 32 // the most steps routed at once: a window of the Amazon's rivers' discharge holds 31 MB

/** A live engine on a grid of ``nX`` cells a row, whose cells are keyed y nX + x. */
export function createLiveEngine(nX) {
  if (!(Number.isInteger(nX) && nX > 0)) throw new Error(`a grid has a whole number of cells a row, not ${nX}`)
  const regions = [] // the id, first position, and count of rivers of each region loaded, in order
  const cellOfKey = new Map() // each cell the loaded regions' weights read, by its key, and its row of the runoff
  const sources = new Map() // each source cell's runoff depth, in meters, given every step until erased
  const underBrush = new Map() // each cell under the brush's depth, given every step until the brush leaves it
  const passedOver = new Map() // each cell the brush passed over since the last step's depth, given once
  let network // every region's rivers' ids, and the network kernel.js routes of them
  let stepper
  let [riverDischarge, riverClasses] = [new Float32Array(0), new Float32Array(0)]
  let stepsRouted = 0
  // each gauge's river id, its river, or -1 until its region is loaded, and its history: a row of GAUGE_STEPS
  // discharges, NaN where none was recorded, each step at the column of its count of steps recorded, modulo GAUGE_STEPS
  let gauges = { riverIds: new Int32Array(0), rivers: new Int32Array(0), history: new Float32Array(0) }
  let stepsRecorded = 0

  /**
   * Write the runoff depth of the next ``steps`` steps into the stepper's window: each source's and each cell under
   * the brush's every step, and each cell passed over but not under the brush in the first step only.
   */
  function giveRunoff(steps) {
    stepper.depth.fill(0)
    const give = (cellKey, depth, stop) => {
      const cell = cellOfKey.get(cellKey) // a cell no loaded region's weights read gives no river runoff
      for (let step = 0; cell !== undefined && step < stop; step++) {
        stepper.depth[cell * STEPS_PER_WINDOW + step] += depth
      }
    }
    for (const [cellKey, depth] of sources) give(cellKey, depth, steps)
    for (const [cellKey, depth] of underBrush) give(cellKey, depth, steps)
    for (const [cellKey, depth] of passedOver) if (!underBrush.has(cellKey)) give(cellKey, depth, 1)
    passedOver.clear() // given once
  }

  /** Find each gauge's river, or -1 while no region loaded holds it. */
  function locateGauges() {
    gauges.rivers = gauges.riverIds.map(riverId => (network === undefined ? -1 : network.riverIds.indexOf(riverId)))
  }

  /** Record each gauge's discharge at the end of each of the ``steps`` steps just routed, over the oldest kept. */
  function recordGauges(steps) {
    for (let gauge = 0; gauge < gauges.rivers.length; gauge++) {
      const series = gauges.rivers[gauge] < 0 ? undefined : stepper.riverSeries(gauges.rivers[gauge])
      for (let step = 0; step < steps; step++) {
        const column = (stepsRecorded + step) % GAUGE_STEPS
        gauges.history[gauge * GAUGE_STEPS + column] = series === undefined ? NaN : series[step]
      }
    }
    stepsRecorded += steps
  }

  /** Each river's discharge after the last step, its last sub-reach's. */
  function dischargeOfRivers() {
    const channelState = stepper.channelState()
    for (let river = 0; river < riverDischarge.length; river++) {
      riverDischarge[river] = channelState[network.subReachStarts[river + 1] - 1]
    }
    return riverDischarge
  }

  const checkDepth = depth => {
    if (!(depth >= 0)) throw new Error(`runoff depth is 0 or more meters, not ${depth}`)
  }

  return {
    /** Load a region, as prepareRegion reads it, as ``id``, unless it is loaded already. */
    addRegion(id, region) {
      if (regions.some(loaded => loaded.id === id)) return
      const first = network === undefined ? 0 : network.riverIds.length
      const carried = stepper === undefined ? undefined : Float32Array.from(stepper.channelState())
      const weightCells = Int32Array.from(region.weightCellY, (y, weight) => {
        const cellKey = y * nX + region.weightCellX[weight]
        if (!cellOfKey.has(cellKey)) cellOfKey.set(cellKey, cellOfKey.size)
        return cellOfKey.get(cellKey)
      })
      network = joinNetworks(network, region, weightCells)
      regions.push({ id, first, nRivers: region.riverIds.length })
      stepper = startWindows(network, { nCells: cellOfKey.size, stepsPerWindow: STEPS_PER_WINDOW })
      riverDischarge = new Float32Array(network.riverIds.length)
      riverClasses = new Float32Array(network.riverIds.length)
      if (carried !== undefined) { // every sub-reach already routing keeps its discharge, ahead of the region's
        const channelState = new Float32Array(stepper.channelState().length)
        channelState.set(carried)
        stepper.setChannelState(channelState)
      }
      locateGauges()
    },
    /**
     * Gauge the rivers ``riverIds``, at most MOST_GAUGES, keeping the history of each gauged already, and starting the
     * others' with none. A river of a region not loaded is gauged once its region loads.
     */
    setGauges(riverIds) {
      if (!(riverIds.length <= MOST_GAUGES && riverIds.every(Number.isInteger))) {
        throw new Error(`at most ${MOST_GAUGES} rivers can be gauged, each by its river id`)
      }
      const history = new Float32Array(riverIds.length * GAUGE_STEPS).fill(NaN)
      riverIds.forEach((riverId, gauge) => {
        const kept = gauges.riverIds.indexOf(riverId)
        if (kept < 0) return
        history.set(gauges.history.subarray(kept * GAUGE_STEPS, (kept + 1) * GAUGE_STEPS), gauge * GAUGE_STEPS)
      })
      gauges = { riverIds: Int32Array.from(riverIds), rivers: new Int32Array(0), history }
      locateGauges()
    },
    /**
     * Each gauge's river id, and its history of the last GAUGE_STEPS steps, a row a gauge, oldest to newest, NaN where
     * none was recorded.
     */
    gaugeHistory() {
      const history = new Float32Array(gauges.history.length)
      const oldest = stepsRecorded % GAUGE_STEPS // the column of the oldest step kept, and of the next recorded
      for (let gauge = 0; gauge < gauges.riverIds.length; gauge++) {
        const row = gauges.history.subarray(gauge * GAUGE_STEPS, (gauge + 1) * GAUGE_STEPS)
        history.set(row.subarray(oldest), gauge * GAUGE_STEPS)
        history.set(row.subarray(0, oldest), gauge * GAUGE_STEPS + GAUGE_STEPS - oldest)
      }
      return { riverIds: Int32Array.from(gauges.riverIds), history }
    },
    /** Make each cell of ``cellKeys`` a source of ``depth`` meters of runoff every step, or none when it is 0. */
    setRunoff(cellKeys, depth) {
      checkDepth(depth)
      for (const cellKey of cellKeys) {
        if (depth > 0) sources.set(cellKey, depth)
        else sources.delete(cellKey)
      }
    },
    /**
     * Pulse ``depth`` meters of runoff into the cells ``nowUnderBrush`` every step until the next pulse, and into the
     * cells ``nowPassedOver`` once, at the next step.
     */
    pulse(nowUnderBrush, nowPassedOver, depth) {
      checkDepth(depth)
      underBrush.clear()
      for (const cellKey of nowUnderBrush) if (depth > 0) underBrush.set(cellKey, depth)
      for (const cellKey of nowPassedOver) if (depth > 0) passedOver.set(cellKey, depth)
    },
    /** Erase every source, and stop every pulse. */
    clearRunoff() {
      sources.clear()
      underBrush.clear()
      passedOver.clear()
    },
    /** Empty every river, and forget every gauge's history. */
    drain() {
      stepper?.setChannelState(new Float32Array(stepper.channelState().length))
      gauges.history.fill(NaN)
    },
    /** Route ``nSteps`` steps, each forced by the sources and the pulses, a window of steps at a time. */
    route(nSteps) {
      for (let first = 0; first < nSteps && stepper !== undefined; first += STEPS_PER_WINDOW) {
        const steps = Math.min(STEPS_PER_WINDOW, nSteps - first)
        giveRunoff(steps)
        stepper.route(steps)
        stepsRouted += steps
        if (gauges.riverIds.length > 0) recordGauges(steps)
      }
    },
    /** Each river's discharge after the last step, in network order, which the next step overwrites. */
    discharge: dischargeOfRivers,
    /** Each river's discharge class, in network order, as classifyDischarge gives. */
    dischargeClasses: classing => classifyDischarge(dischargeOfRivers(), classing, riverClasses),
    riverIds: () => network?.riverIds ?? new Int32Array(0),
    regions: () => regions.map(region => ({ ...region })),
    sourceCells: () => sources.size,
    stepsRouted: () => stepsRouted,
  }
}

/**
 * The rivers of ``network``, or none, then those of ``region``, each draining where it did in its own network: their
 * ids, and the network kernel.js routes of them, each region's sub-reaches and weights after the last's, its weights
 * reading ``weightCells``.
 */
function joinNetworks(network, { riverIds, network: added }, weightCells) {
  const join = (ArrayType, before, after, shift = 0) => {
    const joined = new ArrayType((before?.length ?? 0) + after.length)
    if (before !== undefined) joined.set(before)
    joined.set(shift === 0 ? after : after.map(value => value + shift), before?.length ?? 0)
    return joined
  }
  const nRivers = network?.riverIds.length ?? 0
  const lastOf = starts => starts?.[starts.length - 1] ?? 0
  return {
    riverIds: join(Int32Array, network?.riverIds, riverIds),
    subReachStarts: join(Int32Array, network?.subReachStarts.subarray(0, nRivers), added.subReachStarts,
      lastOf(network?.subReachStarts)),
    inflowRiverStarts: join(Int32Array, network?.inflowRiverStarts.subarray(0, nRivers), added.inflowRiverStarts,
      lastOf(network?.inflowRiverStarts)),
    inflowRivers: join(Int32Array, network?.inflowRivers, added.inflowRivers, nRivers),
    outlets: join(Int32Array, network?.outlets, added.outlets, nRivers),
    c1: join(Float32Array, network?.c1, added.c1),
    c2: join(Float32Array, network?.c2, added.c2),
    c3: join(Float32Array, network?.c3, added.c3),
    c4: join(Float32Array, network?.c4, added.c4),
    weightStarts: join(Int32Array, network?.weightStarts.subarray(0, nRivers), added.weightStarts,
      lastOf(network?.weightStarts)),
    weightCells: join(Int32Array, network?.weightCells, weightCells),
    weights: join(Float32Array, network?.weights, added.weights),
  }
}
