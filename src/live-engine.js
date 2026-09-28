/**
 * Live routing: every river of the regions loaded, routed a step at a time without end, forced by runoff given to
 * grid cells two ways. A source gives its cell a depth every step until it is erased; a pulse gives its depth to the
 * cells under the brush every step it stays over them, and once to each cell it passed over since the last step. The
 * regions' rivers make one network, each region's after the last's, so that a region loaded later joins without
 * disturbing the rivers already routing: each keeps its discharge. A gauge records its river's discharge every step,
 * keeping only the last GAUGE_STEPS, so that its history never grows past them.
 */
import { startLiveSteps } from './muskingum-wasm.js'

export const GAUGE_STEPS = 3600 // the steps of discharge each gauge keeps, the last 30 days of hours
export const MOST_GAUGES = 6
const NO_CONTRIBUTIONS = { levelPositions: new Int32Array(0), forcing: new Float32Array(0) }

/** A live engine on a grid of ``nX`` cells a row, whose cells are keyed y nX + x. */
export function createLiveEngine(nX) {
  if (!(Number.isInteger(nX) && nX > 0)) throw new Error(`a grid has a whole number of cells a row, not ${nX}`)
  const regions = [] // the id, first position, and count of rivers of each region loaded, in order
  const cellWeights = new Map() // each cell's weights: the rivers they force, and the forcing of a meter of depth
  const sources = new Map() // each source cell's runoff depth, in meters, given every step until erased
  const underBrush = new Map() // each cell under the brush's depth, given every step until the brush leaves it
  const passedOver = new Map() // each cell the brush passed over since the last step's depth, given once
  let network // every region's rivers' ids, downstream positions, and coefficients, in regions' order
  let stepper
  let [sourceForcing, pulseForcing] = [NO_CONTRIBUTIONS, NO_CONTRIBUTIONS] // what each adds to its rivers each step
  let stepsRouted = 0
  // each gauge's river id, its level position, or -1 until its region is loaded, and its history: a row of GAUGE_STEPS
  // discharges, NaN where none was recorded, each step at the column of its count of steps recorded, modulo GAUGE_STEPS
  let gauges = { riverIds: new Int32Array(0), levels: new Int32Array(0), history: new Float32Array(0) }
  let stepsRecorded = 0

  /** The forcing ``cells``, each cell's key and depth, add each step to the rivers their weights force. */
  function forcingOf(cells) {
    const [levelPositions, forcing] = [[], []]
    for (const [cellKey, depth] of cells) {
      const weights = cellWeights.get(cellKey)
      for (let weight = 0; weights !== undefined && weight < weights.positions.length; weight++) {
        levelPositions.push(stepper.levelPositions[weights.positions[weight]])
        forcing.push(depth * weights.forcing[weight])
      }
    }
    return { levelPositions: Int32Array.from(levelPositions), forcing: Float32Array.from(forcing) }
  }

  function gatherSources() {
    if (stepper !== undefined) sourceForcing = forcingOf(sources)
  }

  function gatherPulses() {
    if (stepper !== undefined) pulseForcing = forcingOf(new Map([...passedOver, ...underBrush]))
  }

  /** Find each gauge's river in the stepper's level order, or -1 while no region loaded holds it. */
  function locateGauges() {
    gauges.levels = gauges.riverIds.map(riverId => {
      const position = network === undefined ? -1 : network.riverIds.indexOf(riverId)
      return position < 0 ? -1 : stepper.levelPositions[position]
    })
  }

  /** Record each gauge's discharge after the step just routed, over the oldest step its history keeps. */
  function recordGauges() {
    const column = stepsRecorded % GAUGE_STEPS
    for (let gauge = 0; gauge < gauges.levels.length; gauge++) {
      const level = gauges.levels[gauge]
      gauges.history[gauge * GAUGE_STEPS + column] = level < 0 ? NaN : stepper.levelDischarge[level]
    }
    stepsRecorded++
  }

  const checkDepth = depth => {
    if (!(depth >= 0)) throw new Error(`runoff depth is 0 or more meters, not ${depth}`)
  }

  return {
    /** Load a region, as prepareRegion reads it, as ``id``, unless it is loaded already. */
    addRegion(id, region) {
      if (regions.some(loaded => loaded.id === id)) return
      const first = network === undefined ? 0 : network.riverIds.length
      const carried = stepper === undefined ? undefined : Float32Array.from(stepper.discharge())
      network = joinNetworks(network, region)
      for (let weight = 0; weight < region.weightRiver.length; weight++) {
        const cellKey = region.weightCellY[weight] * nX + region.weightCellX[weight]
        if (!cellWeights.has(cellKey)) cellWeights.set(cellKey, { positions: [], forcing: [] })
        cellWeights.get(cellKey).positions.push(first + region.weightRiver[weight])
        cellWeights.get(cellKey).forcing.push(region.weightForcing[weight])
      }
      regions.push({ id, first, nRivers: region.riverIds.length })
      stepper = startLiveSteps(network)
      if (carried !== undefined) {
        const discharge = new Float32Array(network.riverIds.length)
        discharge.set(carried)
        stepper.setDischarge(discharge)
      }
      gatherSources()
      gatherPulses()
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
      gauges = { riverIds: Int32Array.from(riverIds), levels: new Int32Array(0), history }
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
      gatherSources()
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
      gatherPulses()
    },
    /** Erase every source, and stop every pulse. */
    clearRunoff() {
      sources.clear()
      underBrush.clear()
      passedOver.clear()
      gatherSources()
      gatherPulses()
    },
    /** Empty every river, and forget every gauge's history. */
    drain() {
      stepper?.setDischarge(new Float32Array(network.riverIds.length))
      gauges.history.fill(NaN)
    },
    /** Route ``nSteps`` steps, each forced by the sources and the pulses. */
    route(nSteps) {
      for (let step = 0; step < nSteps && stepper !== undefined; step++) {
        for (const { levelPositions, forcing } of [sourceForcing, pulseForcing]) {
          for (let index = 0; index < levelPositions.length; index++) {
            stepper.forcing[levelPositions[index]] += forcing[index]
          }
        }
        stepper.route()
        stepsRouted++
        if (gauges.riverIds.length > 0) recordGauges()
        if (passedOver.size > 0) {
          passedOver.clear() // given once
          gatherPulses()
        }
      }
    },
    /** Each river's discharge, in network order, a view that the next step overwrites. */
    discharge: () => stepper.discharge(),
    /** Each river's discharge class, in network order, as the stepper's dischargeClasses gives. */
    dischargeClasses: classing => stepper.dischargeClasses(classing),
    riverIds: () => network?.riverIds ?? new Int32Array(0),
    regions: () => regions.map(region => ({ ...region })),
    sourceCells: () => sources.size,
    stepsRouted: () => stepsRouted,
  }
}

/** The rivers of ``network``, or none, then those of ``region``, each draining where it did in its own network. */
function joinNetworks(network, { riverIds, downstreamPositions, c1, c2, c3 }) {
  const first = network === undefined ? 0 : network.riverIds.length
  const join = (ArrayType, before, after) => {
    const joined = new ArrayType(first + after.length)
    if (before !== undefined) joined.set(before)
    joined.set(after, first)
    return joined
  }
  const shifted = downstreamPositions.map(downstream => (downstream >= 0 ? downstream + first : -1))
  return {
    riverIds: join(Int32Array, network?.riverIds, riverIds),
    downstreamPositions: join(Int32Array, network?.downstreamPositions, shifted),
    c1: join(Float64Array, network?.c1, c1),
    c2: join(Float64Array, network?.c2, c2),
    c3: join(Float64Array, network?.c3, c3),
  }
}
