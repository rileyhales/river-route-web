/**
 * Muskingum routing with static coefficients and the uniform runoff transform, one reach per river at the runoff step,
 * every river starting from no discharge: the routing kernel, run by the page's worker and by the pool's workers.
 */

/**
 * Route rivers in order, each river's whole series before the next, and return the series of every outlet, a river
 * whose downstream position is -1 because it drains out of the rivers routed, as consecutive rows in routing order.
 * A river's upstream inflow is summed into a row of a small pool, taken when its first upstream river is routed or when
 * a series routed elsewhere is injected into it, and given back once the river itself is routed.
 *
 * Each river reads its runoff from two weighted rows: its catchment's one or two cells, the second given no weight when
 * there is one, or its first cell and a scratch row that sums the rest. Most catchments cover one or two cells, and
 * reading them as it routes measured 30% faster than summing every river's runoff into a row of its own first.
 */
export function routeRivers(network, runoffByCell, nSteps) {
  checkNetwork(network, runoffByCell, nSteps)
  const { downstreamPositions, c1, c2, c3, weightStart, weightCell, weightForcing } = network
  const { injectedRivers = new Int32Array(0), injectedSeries = [] } = network
  const nRivers = downstreamPositions.length
  const nRows = countPeakInflowRows(downstreamPositions, injectedRivers)
  const nOutlets = downstreamPositions.filter(downstream => downstream < 0).length
  // the pool's rows, then a row that stays zero, the inflow of a headwater, then a row per outlet
  const inflowRows = new Float64Array((nRows + 1 + nOutlets) * nSteps)
  const freeRows = Int32Array.from({ length: nRows }, (_, row) => row)
  const rowOfRiver = new Int32Array(nRivers).fill(-1)
  const spareRunoff = new Float32Array(2 * nSteps) // a row of zeros, then the scratch row
  let nFreeRows = nRows
  let nextOutletRow = nRows + 1
  let nextInjection = 0
  const takeRow = river => {
    rowOfRiver[river] = freeRows[--nFreeRows]
    inflowRows.fill(0, rowOfRiver[river] * nSteps, (rowOfRiver[river] + 1) * nSteps)
  }
  for (let river = 0; river < nRivers; river++) {
    for (; injectedRivers[nextInjection] === river; nextInjection++) {
      if (rowOfRiver[river] < 0) takeRow(river)
      addSeries(inflowRows, rowOfRiver[river] * nSteps, injectedSeries[nextInjection])
    }
    const firstWeight = weightStart[river]
    const stopWeight = weightStart[river + 1]
    let secondRunoff = spareRunoff
    let secondStart = 0 // the row of zeros
    let secondForcing = 0
    if (stopWeight - firstWeight === 2) {
      secondRunoff = runoffByCell
      secondStart = weightCell[firstWeight + 1] * nSteps
      secondForcing = weightForcing[firstWeight + 1]
    } else if (stopWeight - firstWeight > 2) {
      sumWeightedRunoff(spareRunoff, nSteps, runoffByCell, weightCell, weightForcing, firstWeight + 1, stopWeight)
      secondStart = nSteps // the scratch row
      secondForcing = 1
    }
    const downstream = downstreamPositions[river]
    if (downstream >= 0 && rowOfRiver[downstream] < 0) takeRow(downstream)
    const inflowRow = rowOfRiver[river] >= 0 ? rowOfRiver[river] : nRows
    const outflowRow = downstream >= 0 ? rowOfRiver[downstream] : nextOutletRow++
    routeRiver(inflowRows, inflowRow * nSteps, outflowRow * nSteps, nSteps, c1[river], c2[river], c3[river],
      runoffByCell, weightCell[firstWeight] * nSteps, weightForcing[firstWeight],
      secondRunoff, secondStart, secondForcing)
    if (rowOfRiver[river] >= 0) freeRows[nFreeRows++] = rowOfRiver[river]
  }
  return inflowRows.slice((nRows + 1) * nSteps)
}

/**
 * Check every array routing reads, since this is the last point where a wrong one can be caught: a typed array read
 * past its end gives undefined, which routing would carry on with as NaN rather than raise.
 */
function checkNetwork(network, runoffByCell, nSteps) {
  const { downstreamPositions, c1, c2, c3, weightStart, weightCell, weightForcing } = network
  const { injectedRivers = new Int32Array(0), injectedSeries = [] } = network
  const nRivers = downstreamPositions.length
  const nCells = runoffByCell.length / nSteps
  const fail = problem => { throw new Error(`routing cannot use this network: ${problem}`) }
  if (!(Number.isInteger(nSteps) && nSteps > 0 && Number.isInteger(nCells))) fail(`${nSteps} steps of runoff`)
  if ([c1, c2, c3].some(array => array.length !== nRivers) || weightStart.length !== nRivers + 1) {
    fail(`coefficients or weights for other than its ${nRivers} rivers`)
  }
  for (let river = 0; river < nRivers; river++) {
    const downstream = downstreamPositions[river]
    if (!(downstream === -1 || (downstream > river && downstream < nRivers))) fail(`river ${river} drains upstream`)
    if (!(weightStart[river + 1] > weightStart[river])) fail(`river ${river} has no weights`)
  }
  const nWeights = weightStart[nRivers]
  if (weightStart[0] !== 0 || weightCell.length !== nWeights || weightForcing.length !== nWeights) fail('its weights')
  if (weightCell.some(cell => !(cell >= 0 && cell < nCells))) fail(`a weight outside its ${nCells} cells of runoff`)
  if (injectedSeries.length !== injectedRivers.length) fail('a different number of injected rivers and series')
  for (let injection = 0; injection < injectedRivers.length; injection++) {
    if (!(injectedRivers[injection] >= (injectedRivers[injection - 1] ?? 0) && injectedRivers[injection] < nRivers)) {
      fail('its injected rivers, which must be positions in increasing order')
    }
    if (injectedSeries[injection]?.length !== nSteps) fail(`an injected series that is not ${nSteps} steps long`)
  }
}

/** The most inflow rows open at once when the rivers are routed in order, which sizes the pool. */
function countPeakInflowRows(downstreamPositions, injectedRivers) {
  const hasRow = new Uint8Array(downstreamPositions.length)
  let [open, peak, nextInjection] = [0, 0, 0]
  const openRow = river => {
    if (hasRow[river] === 1) return
    hasRow[river] = 1
    open++
    peak = Math.max(peak, open)
  }
  for (let river = 0; river < downstreamPositions.length; river++) {
    for (; injectedRivers[nextInjection] === river; nextInjection++) openRow(river)
    if (downstreamPositions[river] >= 0) openRow(downstreamPositions[river])
    if (hasRow[river] === 1) open--
  }
  return peak
}

function addSeries(rows, start, series) {
  for (let step = 0; step < series.length; step++) rows[start + step] += series[step]
}

/** Write the weighted sum of the runoff of weights firstWeight:stopWeight into the scratch row, the second row. */
function sumWeightedRunoff(spareRunoff, nSteps, runoffByCell, weightCell, weightForcing, firstWeight, stopWeight) {
  spareRunoff.fill(0, nSteps)
  for (let weight = firstWeight; weight < stopWeight; weight++) {
    const [cellStart, forcing] = [weightCell[weight] * nSteps, weightForcing[weight]]
    for (let step = 0; step < nSteps; step++) spareRunoff[nSteps + step] += forcing * runoffByCell[cellStart + step]
  }
}

/**
 * Route one river's whole series and add it into its outflow row: q = c3 q + c1 I_end + c2 I_start + its runoff's
 * forcing at each step, from q = 0 and an inflow of 0 at the start of the first step. The loop runs at the latency of
 * q's multiply and add; unrolling it into groups of 2, 4, or 8 steps with powers of c3, as river-route's numba kernel
 * does, measured slower in V8.
 */
function routeRiver(inflowRows, inflowStart, outflowStart, nSteps, c1, c2, c3,
  firstRunoff, firstStart, firstForcing, secondRunoff, secondStart, secondForcing) {
  let discharge = 0
  let inflowBefore = 0
  for (let step = 0; step < nSteps; step++) {
    const inflow = inflowRows[inflowStart + step]
    discharge = c3 * discharge + (c1 * inflow + c2 * inflowBefore
      + firstForcing * firstRunoff[firstStart + step] + secondForcing * secondRunoff[secondStart + step])
    inflowRows[outflowStart + step] += discharge
    inflowBefore = inflow
  }
}
