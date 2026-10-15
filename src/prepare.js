/**
 * The setup of river-route's routing, ported from its Python under the same names so that a change to one is carried to
 * the other: the checks of Network, its conditioning with _equal_layout, _sub_reach_shares_and_x, and _split_unequally,
 * splitting.fewest_sub_reaches, static_muskingum's prepare_routing and _combine_subcycles, and streams.assign_blocks.
 * Every decision of a run is settled here in float64, as the Python settles it, and kernel.js routes what it gives with
 * routing.c.
 *
 * prepareRouting gives a network in the form of routing.h's rr_network: each river's sub-reaches and inflow rivers, and
 * the coefficients of every sub-reach. The weights of each river's runoff cells are added to it before it is routed.
 */
const DT_ROUTING_AUTO = 'auto'
const ACTIONS = ['log', 'raise', 'ignore']
const MAX_STABILIZED_X = 0.49 // Network.MAX_STABILIZED_X
// checks.c's limits, which Network.check_routable refuses a network beyond
const MAX_RIVERS = 16777216
const MAX_SUB_REACHES = 67108864
const MAX_SUB_REACHES_PER_RIVER = 256
const MAX_INFLOW_RIVERS_PER_RIVER = 65536
// splitting's MARGIN, the share of a river's diffusion its windows are held inside their edges by; SHORTEST_SHARE, the
// shortest sub-reach as a share of the shorter of the river's travel time and the step; and MAX_PAIRS, the most totals
// one more sub-reach is added to at once
const MARGIN = 1e-3
const SHORTEST_SHARE = 1 / 64
const MAX_PAIRS = 2 ** 22
// streams._BLOCK_CAP_FRACTIONS: the caps on the rivers in a block tried, as fractions of an even share of them per job
const BLOCK_CAP_FRACTIONS = [0.125, 0.25, 0.375, 0.5, 0.65, 0.8, 1.0]

/**
 * Settle every decision of routing the rivers of ``network``, in routing order: each river's downstreamIndices, the
 * river it drains into or -1, and its muskingumK and muskingumX as k and x, read in float64 whatever array holds them.
 * ``options`` are those of a Configs: dtRunoff, the runoff step in seconds; dtRouting, 'auto' or every river's step, a
 * divisor of it; useSubreaches and useSubcycles, true unless given, both of which 'auto' requires; and
 * invalidCoefficients, 'log', 'raise', or 'ignore', 'raise' unless given.
 *
 * Returns the network kernel.js routes once its weights are added: subReachStarts, each river's first sub-reach then
 * the count of them; inflowRiverStarts and inflowRivers, the rivers draining directly into each river; c1, c2, c3, and
 * c4 of each sub-reach; and outlets, the rivers that drain into none.
 */
export function prepareRouting(network, options) {
  const { dtRunoff, dtRouting = DT_ROUTING_AUTO, useSubreaches = true, useSubcycles = true } = options
  const { invalidCoefficients = 'raise' } = options
  checkTimeSteps(dtRunoff, dtRouting, useSubreaches, useSubcycles)
  if (!ACTIONS.includes(invalidCoefficients)) throw new Error(`invalidCoefficients must be one of ${ACTIONS}`)
  const topology = inflowsOf(network.downstreamIndices)
  const [k, x] = [Float64Array.from(network.k), Float64Array.from(network.x)]
  const stabilize = { useSubreaches, useSubcycles }
  return { ...topology, ...prepareStaticRouting(k, x, topology, dtRunoff, dtRouting, stabilize, invalidCoefficients) }
}

/**
 * Configs and Router._validate_time_options for the steps prepare_routing reads: dtRouting divides dtRunoff, and
 * 'auto' routes with useSubreaches and useSubcycles.
 */
function checkTimeSteps(dtRunoff, dtRouting, useSubreaches, useSubcycles) {
  if (!(Number.isInteger(dtRunoff) && dtRunoff > 0)) throw new Error(`dtRunoff must be whole seconds, not ${dtRunoff}`)
  if (dtRouting === DT_ROUTING_AUTO) {
    if (useSubreaches && useSubcycles) return
    throw new Error("dtRouting 'auto' requires useSubreaches and useSubcycles; give dtRouting in seconds to turn either off")
  }
  if (!(Number.isInteger(dtRouting) && dtRouting > 0)) {
    throw new Error(`dtRouting must be 'auto' or whole seconds, not ${dtRouting}`)
  }
  if (dtRunoff % dtRouting !== 0) throw new Error(`dtRunoff ${dtRunoff} must be a whole multiple of dtRouting`)
}

/**
 * Network.set_connectivity's inflow rivers: the rivers draining directly into each river, in routing order, every one
 * before the river it drains into, and the outlets, the rivers that drain into none.
 */
function inflowsOf(downstreamIndices) {
  const nRivers = downstreamIndices.length
  const inflowRiverStarts = new Int32Array(nRivers + 1)
  for (let river = 0; river < nRivers; river++) {
    const downstream = downstreamIndices[river]
    if (downstream !== -1 && !(downstream > river && downstream < nRivers)) {
      throw new Error(`river ${river} drains into ${downstream}, not a river after it`)
    }
    if (downstream >= 0) inflowRiverStarts[downstream + 1]++
  }
  for (let river = 0; river < nRivers; river++) inflowRiverStarts[river + 1] += inflowRiverStarts[river]
  const inflowRivers = new Int32Array(inflowRiverStarts[nRivers])
  const nextEntry = inflowRiverStarts.slice(0, nRivers)
  const outlets = []
  for (let river = 0; river < nRivers; river++) {
    const downstream = downstreamIndices[river]
    if (downstream >= 0) inflowRivers[nextEntry[downstream]++] = river
    else outlets.push(river)
  }
  return { inflowRiverStarts, inflowRivers, outlets: Int32Array.from(outlets) }
}

/**
 * streams.assign_blocks: divide the rivers of ``network``, prepareRouting's result for rivers in DFS order, into
 * sub-watershed blocks, pack the blocks into ``nJobs`` jobs that route at once, and leave every other river to the main
 * stem, the last job, which routes from the discharge of the blocks' outlets after them. Each job is { starts, stops },
 * its blocks in routing order, each the rivers from a start up to a stop, the last of which is the block's outlet.
 */
export function assignBlocks({ inflowRiverStarts, inflowRivers }, nJobs) {
  if (!(Number.isInteger(nJobs) && nJobs > 0)) throw new Error(`blocks are packed into whole jobs, not ${nJobs}`)
  const nRivers = inflowRiverStarts.length - 1
  const watershedSizes = new Int32Array(nRivers).fill(1)
  const downstreamWatershedSizes = new Int32Array(nRivers).fill(nRivers + 1)
  for (let river = 0; river < nRivers; river++) {
    for (let entry = inflowRiverStarts[river]; entry < inflowRiverStarts[river + 1]; entry++) {
      watershedSizes[river] += watershedSizes[inflowRivers[entry]]
    }
    for (let entry = inflowRiverStarts[river]; entry < inflowRiverStarts[river + 1]; entry++) {
      const inflow = inflowRivers[entry]
      if (inflow - watershedSizes[inflow] < river - watershedSizes[river]) {
        throw new Error('the network is not in DFS order: the rivers upstream of a river must be the rows before it')
      }
      downstreamWatershedSizes[inflow] = watershedSizes[river]
    }
  }
  let [blockOutlets, jobOfBlock, fewestRiversInBusiestJobAndMainStem] = [[], [], nRivers]
  for (const fraction of BLOCK_CAP_FRACTIONS) {
    const cap = Math.max(1, Math.trunc((fraction * nRivers) / nJobs))
    const outlets = []
    for (let river = 0; river < nRivers; river++) {
      if (watershedSizes[river] <= cap && downstreamWatershedSizes[river] > cap) outlets.push(river)
    }
    const blockSizes = outlets.map(outlet => watershedSizes[outlet])
    const packed = packBlocksIntoJobs(blockSizes, nJobs)
    const riversInBlocks = blockSizes.reduce((sum, size) => sum + size, 0)
    const riversInBusiestJobAndMainStem = Math.max(...packed.jobSizes) + nRivers - riversInBlocks
    if (riversInBusiestJobAndMainStem < fewestRiversInBusiestJobAndMainStem) {
      ;[blockOutlets, jobOfBlock] = [outlets, packed.jobOfBlock]
      fewestRiversInBusiestJobAndMainStem = riversInBusiestJobAndMainStem
    }
  }
  const blockStarts = blockOutlets.map(outlet => outlet + 1 - watershedSizes[outlet])
  const blockStops = blockOutlets.map(outlet => outlet + 1)
  const jobs = []
  for (let job = 0; job < nJobs; job++) {
    const blocks = blockOutlets.flatMap((_, block) => (jobOfBlock[block] === job ? [block] : []))
    if (blocks.length > 0) {
      const [starts, stops] = [blockStarts, blockStops].map(bounds => Int32Array.from(blocks, block => bounds[block]))
      jobs.push({ starts, stops })
    }
  }
  const [stemStarts, stemStops] = [[0, ...blockStops], [...blockStarts, nRivers]]
  const runs = stemStarts.flatMap((start, run) => (stemStops[run] > start ? [run] : []))
  const [starts, stops] = [stemStarts, stemStops].map(bounds => Int32Array.from(runs, run => bounds[run]))
  jobs.push({ starts, stops })
  return jobs
}

/**
 * pack_blocks_into_jobs: each block, from the largest down, goes to the job with the fewest rivers so far. Returns the
 * job of each block and the number of rivers in each job.
 */
function packBlocksIntoJobs(blockSizes, nJobs) {
  const jobOfBlock = new Int32Array(blockSizes.length)
  const jobSizes = new Array(nJobs).fill(0)
  const largestFirst = blockSizes.map((_, block) => block).sort((a, b) => blockSizes[b] - blockSizes[a])
  for (const block of largestFirst) {
    const job = jobSizes.indexOf(Math.min(...jobSizes))
    jobOfBlock[block] = job
    jobSizes[job] += blockSizes[block]
  }
  return { jobOfBlock, jobSizes }
}

/**
 * static_muskingum.prepare_routing: the sub-reaches of each river, as conditioning lays them out at its step, dtRouting
 * when given and else the runoff step, and the float32 coefficients of each, its subcycles of each runoff step combined
 * into one step by combineSubcycles.
 */
function prepareStaticRouting(k, x, topology, dtRunoff, dtRouting, stabilize, invalidCoefficients) {
  checkParameters(k, x)
  const step = dtRouting === DT_ROUTING_AUTO ? dtRunoff : dtRouting
  if (stabilize.useSubreaches || stabilize.useSubcycles) checkStabilizable(x)
  const layout = conditioning(k, x, step, stabilize)
  checkRoutable(layout.subReaches, topology.inflowRiverStarts, k, x)
  checkValidity(k, x, step, invalidCoefficients, layout)
  const nRivers = k.length
  const subReachStarts = startsOf(layout.subReaches)
  const [c1, c2, c3, c4] = Array.from({ length: 4 }, () => new Float32Array(subReachStarts[nRivers]))
  for (let river = 0; river < nRivers; river++) {
    for (let index = subReachStarts[river]; index < subReachStarts[river + 1]; index++) {
      const [kReach, xReach] = [layout.k[index], layout.x[index]]
      const share = kReach / k[river] // of the river's k, and of its runoff
      const subcycles = (dtRunoff / step) * layout.subcycles[index] // the steps of its own in each runoff step
      const dtDivK = dtRunoff / subcycles / kReach // the sub-reach's own step over its k
      const denominator = dtDivK + 2 * (1 - xReach)
      const each = [
        (dtDivK - 2 * xReach) / denominator,
        (dtDivK + 2 * xReach) / denominator,
        (2 * (1 - xReach) - dtDivK) / denominator,
      ]
      const runoffC4 = ((each[0] + each[1]) * share) / dtRunoff
      const combined = combineSubcycles(...each, runoffC4, subcycles)
      if (!(Math.abs(combined[0] + combined[1] + combined[2] - 1) <= 1e-8 + 1e-5)) { // as numpy's allclose tests
        throw new Error('Muskingum coefficients do not sum to 1, check k and x of the network file and dtRouting')
      }
      ;[c1[index], c2[index], c3[index], c4[index]] = combined
    }
  }
  return { subReachStarts, c1, c2, c3, c4 }
}

/** Each river's first entry, then the count of entries, from the count of each river's entries. */
function startsOf(counts) {
  const starts = new Int32Array(counts.length + 1)
  for (let index = 0; index < counts.length; index++) starts[index + 1] = starts[index] + counts[index]
  return starts
}

/**
 * Network.check_parameters: k positive and finite, x finite and from 0 to 1/2, the travel times and weights that a
 * routing step can route.
 */
function checkParameters(k, x) {
  for (let river = 0; river < k.length; river++) {
    if (!(Number.isFinite(k[river]) && k[river] > 0)) {
      throw new Error(`muskingumK must be positive and finite, but river ${river} has k = ${k[river]}`)
    }
    if (!(Number.isFinite(x[river]) && x[river] >= 0 && x[river] <= 0.5)) {
      throw new Error(`muskingumX must be finite and from 0 to 0.5, but river ${river} has x = ${x[river]}`)
    }
  }
}

/**
 * Network.check_stabilizable: refuse the rivers of x above MAX_STABILIZED_X, compared to it as float32 holds it so
 * that x stored in float32 at the limit is accepted. A river needs up to ceil(1/(1-2x)) sub-reaches, and at x = 1/2
 * it can be impossible to stabilize.
 */
function checkStabilizable(x) {
  const limit = Math.fround(MAX_STABILIZED_X)
  const above = []
  for (let river = 0; river < x.length; river++) if (x[river] > limit) above.push(river)
  if (above.length === 0) return
  throw new Error(`${above.length} rivers have a muskingumX above ${MAX_STABILIZED_X}, such as river ${above[0]} with `
    + `x = ${x[above[0]]}, which cannot be stabilized with useSubreaches or useSubcycles. A river needs up to `
    + `ceil(1/(1-2x)) sub-reaches, 50 at x = ${MAX_STABILIZED_X} and many more above it, and at x = 0.5 it can be `
    + `impossible to stabilize. Hold x at or below ${MAX_STABILIZED_X}, or route with dtRouting in seconds and `
    + 'useSubreaches and useSubcycles false.')
}

/**
 * Network._sub_reach_shares_and_x for a river of weight x split into n sub-reaches: the share of k of each of its first
 * n - 1, the share of its last, and the x they all take, which keep the river's mean travel time and its travel time
 * variance with an x of 0 or more.
 */
export function subReachSharesAndX(n, x) {
  const subReachX = Math.max(0, 0.5 - n * (0.5 - x))
  const oneMinusTwoSubReachX = 1 - 2 * subReachX
  const squaredShares = oneMinusTwoSubReachX > 0 ? (1 - 2 * x) / oneMinusTwoSubReachX : 1 / n
  const others = n - 1
  const discriminant = Math.max(others ** 2 - others * n * (1 - squaredShares), 0)
  const largerShare = others > 0 ? (others + Math.sqrt(discriminant)) / (others * n) : 1
  return { largerShare, lastShare: 1 - others * largerShare, subReachX }
}

/** Network.validity_window for one river: the steps from 2kx to 2k(1 - x) at which every coefficient is non-negative. */
export function validityWindow(k, x) {
  return [2 * k * x, 2 * k * (1 - x)]
}

/**
 * Network.invalid_mask: per river, whether it, or with ``layout`` any of its sub-reaches at its own step, dt over its
 * subcycles, is too long for dt (c1 < 0) or too short for it (c3 < 0).
 */
export function invalidMask(k, x, dt, layout) {
  const nRivers = k.length
  const [tooLong, tooShort] = [new Uint8Array(nRivers), new Uint8Array(nRivers)]
  if (layout === undefined) {
    for (let river = 0; river < nRivers; river++) {
      const [lower, upper] = validityWindow(k[river], x[river])
      tooLong[river] = lower > dt ? 1 : 0
      tooShort[river] = upper < dt ? 1 : 0
    }
    return { tooLong, tooShort }
  }
  let index = 0
  for (let river = 0; river < nRivers; river++) {
    for (let subReach = 0; subReach < layout.subReaches[river]; subReach++, index++) {
      const step = dt / layout.subcycles[index]
      if (2 * layout.k[index] * layout.x[index] > step) tooLong[river] = 1
      if (2 * layout.k[index] * (1 - layout.x[index]) < step) tooShort[river] = 1
    }
  }
  return { tooLong, tooShort }
}

/**
 * Network.sub_reaches for one river: the fewest equal sub-reaches whose coefficients are all non-negative at dt,
 * ceil(k / (dt + (1-2x) k)), or 1 where its shortest is too short for dt.
 */
export function subReaches(k, x, dt) {
  const n = Math.max(1, Math.ceil(k / (dt + (1 - 2 * x) * k)))
  const { lastShare, subReachX } = subReachSharesAndX(n, x)
  const resolvable = dt <= 2 * lastShare * k * (1 - subReachX)
  return { subReaches: resolvable ? n : 1, resolvable }
}

/** Network.subcycles for one river: the fewest equal steps within dt that keep it non-negative, or 1 where none do. */
export function subcycles(k, x, dt) {
  const count = Math.max(1, Math.ceil(dt / (2 * k * (1 - x))))
  const resolvable = dt / count >= 2 * k * x
  return { subcycles: resolvable ? count : 1, resolvable }
}

/**
 * Network.conditioning: how each river is routed at dt. A river too long for dt is split into its equal subReaches
 * with useSubreaches, and a river too short for it is routed in its subcycles with useSubcycles; without them it is
 * routed whole. With both, a river neither makes valid, which only a river with x above 1/3 can be, is split into the
 * fewest sub-reaches of unequal travel times that each take subcycles of their own, those of fewestSubReaches, and is
 * kept whole where no split into at most MAX_SUB_REACHES_PER_RIVER is valid.
 *
 * Returns the layout: subReaches, the count of each river's sub-reaches, and k, x, and subcycles, those of each
 * sub-reach, river after river and each river's upstream to downstream.
 */
export function conditioning(k, x, dt, { useSubreaches = true, useSubcycles = true } = {}) {
  const nRivers = k.length
  const { tooLong, tooShort } = invalidMask(k, x, dt)
  const subReachCounts = new Int32Array(nRivers)
  const subcycleCounts = new Int32Array(nRivers)
  const unresolved = []
  for (let river = 0; river < nRivers; river++) {
    const split = subReaches(k[river], x[river], dt)
    const cycled = subcycles(k[river], x[river], dt)
    subReachCounts[river] = tooLong[river] && useSubreaches ? split.subReaches : 1
    subcycleCounts[river] = tooShort[river] && useSubcycles ? cycled.subcycles : 1
    if (tooLong[river] ? !split.resolvable : tooShort[river] && !cycled.resolvable) unresolved.push(river)
  }
  const layout = equalLayout(k, x, subReachCounts, subcycleCounts)
  if (!(useSubreaches && useSubcycles)) return layout
  return splitUnequally(layout, k, x, dt, unresolved)
}

/**
 * Network._equal_layout: each river split into its subReachCounts sub-reaches in series that each take its
 * subcycleCounts, the shares and x of subReachSharesAndX, which keep the river's mean travel time and its variance.
 */
function equalLayout(k, x, subReachCounts, subcycleCounts) {
  const starts = startsOf(subReachCounts)
  const n = starts[k.length]
  const layout = { subReaches: subReachCounts, k: new Float64Array(n), x: new Float64Array(n), subcycles: new Int32Array(n) }
  for (let river = 0; river < k.length; river++) {
    const count = subReachCounts[river]
    const { largerShare, lastShare, subReachX } = subReachSharesAndX(count, x[river])
    for (let subReach = 0; subReach < count; subReach++) {
      const index = starts[river] + subReach
      layout.k[index] = (subReach < count - 1 ? largerShare : lastShare) * k[river]
      layout.x[index] = subReachX
      layout.subcycles[index] = subcycleCounts[river]
    }
  }
  return layout
}

/**
 * Network._split_unequally: ``layout`` with each of ``rivers`` laid out as the fewest unequal sub-reaches of
 * fewestSubReaches where any are, each taking x = 1/2 - (1/2 - x) k / k_i, which keeps the river's diffusion.
 */
function splitUnequally(layout, k, x, dt, rivers) {
  const splits = new Map()
  for (const river of rivers) {
    const split = fewestSubReaches(k[river], x[river], dt, MAX_SUB_REACHES_PER_RIVER)
    if (split.times.length > 0) splits.set(river, split)
  }
  if (splits.size === 0) return layout
  const subReachCounts = Int32Array.from(layout.subReaches, (count, river) => splits.get(river)?.times.length ?? count)
  const [before, after] = [startsOf(layout.subReaches), startsOf(subReachCounts)]
  const n = after[k.length]
  const spliced = { subReaches: subReachCounts, k: new Float64Array(n), x: new Float64Array(n), subcycles: new Int32Array(n) }
  for (let river = 0; river < k.length; river++) {
    const split = splits.get(river)
    for (let subReach = 0; subReach < subReachCounts[river]; subReach++) {
      const [from, to] = [before[river] + subReach, after[river] + subReach]
      if (split === undefined) {
        spliced.k[to] = layout.k[from]
        spliced.x[to] = layout.x[from]
        spliced.subcycles[to] = layout.subcycles[from]
      } else {
        const diffusion = (1 - 2 * x[river]) * k[river]
        spliced.k[to] = split.times[subReach]
        spliced.x[to] = 0.5 - diffusion / (2 * split.times[subReach])
        spliced.subcycles[to] = split.subcycles[subReach]
      }
    }
  }
  return spliced
}

/**
 * Network.check_routable: refuse a network the kernels cannot route as subReachCounts sub-reaches per river, with more
 * rivers, sub-reaches, sub-reaches of one river, or inflow rivers of one river than checks.c allows.
 */
function checkRoutable(subReachCounts, inflowRiverStarts, k, x) {
  const nRivers = subReachCounts.length
  if (nRivers > MAX_RIVERS) throw new Error(`the network has ${nRivers} rivers, more than the ${MAX_RIVERS} the kernels route`)
  let [total, tooMany, most] = [0, 0, -1]
  for (let river = 0; river < nRivers; river++) {
    total += subReachCounts[river]
    if (subReachCounts[river] > MAX_SUB_REACHES_PER_RIVER) {
      tooMany++
      if (most < 0 || subReachCounts[river] > subReachCounts[most]) most = river
    }
  }
  if (total > MAX_SUB_REACHES) {
    throw new Error(`the network is routed as ${total} sub-reaches, more than the ${MAX_SUB_REACHES} the kernels route`)
  }
  if (tooMany > 0) {
    throw new Error(`${tooMany} rivers need more sub-reaches than the ${MAX_SUB_REACHES_PER_RIVER} the kernels route one `
      + `river as. River ${most} needs the most, ${subReachCounts[most]}, with k = ${k[most]} s and x = ${x[most]}. A `
      + 'river with x near 0.5 needs the most: hold x lower in the network file, or route with dtRouting in seconds and '
      + 'useSubreaches false.')
  }
  for (let river = 0; river < nRivers; river++) {
    const inflows = inflowRiverStarts[river + 1] - inflowRiverStarts[river]
    if (inflows > MAX_INFLOW_RIVERS_PER_RIVER) {
      throw new Error(`river ${river} has ${inflows} inflow rivers, more than the ${MAX_INFLOW_RIVERS_PER_RIVER} the `
        + 'kernels route one river with')
    }
  }
}

/** Network.check_validity: report the rivers with a negative coefficient at dt, as laid out, as ``action`` says. */
function checkValidity(k, x, dt, action, layout) {
  if (action === 'ignore') return
  const { tooLong, tooShort } = invalidMask(k, x, dt, layout)
  let [nLong, nShort] = [0, 0]
  for (let river = 0; river < k.length; river++) {
    nLong += tooLong[river]
    nShort += tooShort[river]
  }
  if (nLong === 0 && nShort === 0) return
  report(action, `${nLong + nShort} of ${k.length} rivers have a negative Muskingum coefficient in their step of each `
    + `${dt} s (${nLong} are too long for it, with c1 < 0, and ${nShort} too short, with c3 < 0), so their routing is `
    + 'not valid. Every coefficient is non-negative when 2*k*x <= step <= 2*k*(1-x). Outside that window routing is '
    + 'stable and conserves mass, but discharge can dip below zero ahead of a rise or alternate and go negative, and '
    + 'it is written as routed. Route with useSubreaches to split rivers too long into sub-reaches and useSubcycles to '
    + "give rivers too short the subcycles they need. invalidCoefficients 'raise' refuses to route them, 'log' routes "
    + "them and logs this error, and 'ignore' routes them silently.")
}

function report(action, message) {
  if (action === 'raise') throw new Error(message)
  console.error(message)
}

/**
 * _combine_subcycles for one reach: the coefficients of one step that is s subcycles of it, its inflow rising linearly
 * across them and its runoff spread evenly over them, so that c3' = c3^s and, like each subcycle's, c1' + c2' + c3' is
 * 1. With G the sum of c3^i and A the sum of i c3^i over i from 0 to s - 1, c1' = c1 (G - A/s) + c2 (G - (A + G)/s),
 * c2' = (c1 A + c2 (A + G))/s, and c4' = c4 G. G, A, and c3^s are built over the bits of s, doubling the count of terms
 * at each bit and adding one more where the bit is set, so a reach of s subcycles costs log2(s) steps.
 */
export function combineSubcycles(c1, c2, c3, c4, s) {
  let [power, geometric, weighted, terms] = [1, 0, 0, 0] // c3^n, G, and A of the n terms summed so far
  for (let bit = 31 - Math.clz32(s); bit >= 0; bit--) {
    // the second n terms are the first n times c3^n, each i of them n more
    weighted += power * (weighted + terms * geometric)
    geometric += power * geometric
    power *= power
    terms *= 2
    if (((s >> bit) & 1) === 1) {
      weighted += terms * power
      geometric += power
      power *= c3
      terms += 1
    }
  }
  const combinedC1 = c1 * (geometric - weighted / s) + c2 * (geometric - (weighted + geometric) / s)
  const combinedC2 = (c1 * weighted + c2 * (weighted + geometric)) / s
  return [combinedC1, combinedC2, power, c4 * geometric]
}

/**
 * splitting._windows: the travel times a sub-reach of a river may take in subcycles of dt, as windows from the longest
 * to the shortest: one for each count of subcycles m from the first whose window reaches down to k, and last the window
 * that every count joins into from the first whose window overlaps the next one's. None is shorter than the diffusion,
 * where a sub-reach's x is 0, or than SHORTEST_SHARE of the river or the step.
 */
function windowsOf(k, diffusion, dt) {
  const half = diffusion * (1 - MARGIN)
  const shortest = Math.max(diffusion, SHORTEST_SHARE * Math.min(k, dt))
  const first = Math.max(1, Math.ceil(dt / (k + half)))
  // the last count whose window reaches up to the shortest, or past which every window lies within its window
  const last = Math.max(first, Math.floor(dt / Math.max(shortest - half, half)))
  // windows m and m + 1 overlap when dt / (m (m + 1)) <= 2 half, and so does every pair of windows after them
  const joined = Math.min(Math.max(first, Math.ceil((Math.sqrt(1 + (2 * dt) / half) - 1) / 2)), last)
  const [lower, upper] = [new Float64Array(joined - first + 1), new Float64Array(joined - first + 1)]
  for (let window = 0; window < joined - first; window++) {
    lower[window] = Math.max(shortest, dt / (first + window) - half)
    upper[window] = dt / (first + window) + half
  }
  lower[lower.length - 1] = Math.max(shortest, dt / last - half) // every count from joined to last, joined into one
  upper[upper.length - 1] = dt / joined + half
  return { lower, upper }
}

/** splitting._merge: the union of the intervals from lower to upper, as sorted, disjoint intervals. */
function merge(lower, upper) {
  const order = Array.from(lower, (_, interval) => interval).sort((a, b) => lower[a] - lower[b])
  const [mergedLower, mergedUpper] = [[], []]
  for (const interval of order) {
    const count = mergedLower.length
    if (count > 0 && lower[interval] <= mergedUpper[count - 1]) {
      mergedUpper[count - 1] = Math.max(mergedUpper[count - 1], upper[interval])
    } else {
      mergedLower.push(lower[interval])
      mergedUpper.push(upper[interval])
    }
  }
  return { lower: Float64Array.from(mergedLower), upper: Float64Array.from(mergedUpper) }
}

/** numpy's searchsorted(sorted, value, side='right') - 1: the last position whose value is value or less, or -1. */
function lastAtMost(sorted, value) {
  let [low, high] = [0, sorted.length]
  while (low < high) {
    const middle = (low + high) >> 1
    if (sorted[middle] <= value) low = middle + 1
    else high = middle
  }
  return low - 1
}

/** splitting._holds: whether the sorted, disjoint intervals hold total. */
function holds({ lower, upper }, total) {
  const interval = lastAtMost(lower, total)
  return interval >= 0 && upper[interval] >= total
}

/** splitting._add: the totals, up to k, of one more sub-reach in any of the windows on any of the totals given. */
function add(totals, windows, k) {
  const [sumLower, sumUpper] = [[], []]
  for (let total = 0; total < totals.lower.length; total++) {
    for (let window = 0; window < windows.lower.length; window++) {
      if (totals.lower[total] + windows.lower[window] <= k) {
        sumLower.push(totals.lower[total] + windows.lower[window])
        sumUpper.push(Math.min(totals.upper[total] + windows.upper[window], k))
      }
    }
  }
  return merge(sumLower, sumUpper)
}

/**
 * splitting._last_window: the longest window whose sub-reach, added to one of the totals given, makes total, and the
 * total it is added to, tested as add builds the totals so that rounding cannot lose the one that made total. A window
 * of -1 if none does.
 */
function lastWindow(totals, windows, total) {
  for (let window = 0; window < windows.lower.length; window++) {
    for (let interval = 0; interval < totals.lower.length; interval++) {
      const reaches = totals.lower[interval] + windows.lower[window] <= total
      if (reaches && total <= totals.upper[interval] + windows.upper[window]) {
        const rest = Math.min(totals.upper[interval], total - windows.lower[window])
        return { window, total: Math.max(totals.lower[interval], rest) }
      }
    }
  }
  return { window: -1, total }
}

/**
 * splitting._halves: whether count sub-reaches make k, as a total of the first count - count//2 of them and a total of
 * the last count//2, and those two totals. levels[n - 1] are the totals of n sub-reaches, up to k.
 */
function halves(levels, count, k) {
  const half = Math.floor(count / 2)
  const first = levels[count - half - 1]
  if (count === 1) return { found: holds(first, k), first: k, last: 0 }
  const last = levels[half - 1]
  for (let interval = 0; interval < first.lower.length; interval++) {
    // the last totals' interval reaching furthest down to k minus this one, and the one after it, against rounding
    const match = lastAtMost(last.lower, k - first.lower[interval])
    for (let other = Math.max(match, 0); other < Math.min(match + 2, last.lower.length); other++) {
      const reaches = first.lower[interval] + last.lower[other] <= k
      if (reaches && k <= first.upper[interval] + last.upper[other]) {
        const firstTotal = Math.max(first.lower[interval], Math.min(first.upper[interval], k - last.lower[other]))
        return { found: true, first: firstTotal, last: Math.max(last.lower[other], Math.min(last.upper[other], k - firstTotal)) }
      }
    }
  }
  return { found: false, first: k, last: 0 }
}

/**
 * splitting._read_back: the windows of count sub-reaches whose totals of every count are levels, which make total: from
 * the last sub-reach to the first, the longest window that leaves a total the others make.
 */
function readBack(levels, count, total, windows, k) {
  const chosen = new Int32Array(count)
  if (count === 0) return chosen
  for (let level = count - 1; level > 0; level--) {
    const found = lastWindow(levels[level - 1], windows, total)
    chosen[level] = found.window
    total = found.total
  }
  chosen[0] = -1
  for (let window = 0; window < windows.lower.length; window++) {
    if (windows.lower[window] <= total && total <= Math.min(windows.upper[window], k)) {
      chosen[0] = window
      break
    }
  }
  return chosen
}

/**
 * splitting._travel_times: the travel times of sub-reaches in the windows chosen, longest first, that sum to k: every
 * one the same share of the way across its window, so that none is nearer an edge of its window than it must be.
 */
function travelTimes(chosen, windows, k) {
  const shortest = chosen.map(window => windows.lower[window])
  const longest = chosen.map(window => windows.upper[window])
  const sum = values => values.reduce((total, value) => total + value, 0)
  const span = sum(longest) - sum(shortest)
  const across = span <= 0 ? 0.5 : Math.min(1, Math.max(0, (k - sum(shortest)) / span))
  const times = shortest.map((time, subReach) => time + across * (longest[subReach] - time))
  const scale = k / sum(times)
  return Float64Array.from(times, time => time * scale).sort().reverse()
}

/**
 * splitting.fewest_sub_reaches: the travel times, upstream to downstream, of the fewest sub-reaches of a river, at most
 * ``most``, whose coefficients are all non-negative at dt, and the subcycles of dt each takes: the fewest whose step is
 * in its window. Empty where no split of at most ``most`` sub-reaches is valid, as at x = 1/2, whose windows close to
 * single steps.
 */
export function fewestSubReaches(k, x, dt, most) {
  const none = { times: new Float64Array(0), subcycles: new Int32Array(0) }
  const diffusion = (1 - 2 * x) * k
  if (!(k > 0 && dt > 0 && diffusion > 0) || Math.ceil(k / (dt + diffusion)) > most) return none
  const windows = windowsOf(k, diffusion, dt)
  const reachable = Array.from(windows.lower.keys()).filter(window => windows.lower[window] <= k)
  const levels = [merge( // the totals of 1, 2, ... sub-reaches
    reachable.map(window => windows.lower[window]), reachable.map(window => Math.min(windows.upper[window], k)),
  )]
  for (let count = 1; count <= most; count++) {
    const half = Math.floor(count / 2)
    if (count - half > levels.length) {
      const totals = levels[levels.length - 1]
      if (totals.lower.length * windows.lower.length > MAX_PAIRS) return none
      levels.push(add(totals, windows, k))
    }
    const { found, first, last } = halves(levels, count, k)
    if (!found) continue
    const chosen = [
      ...readBack(levels, count - half, first, windows, k), ...readBack(levels, half, last, windows, k),
    ]
    if (chosen.some(window => window < 0)) return none
    const times = travelTimes(chosen, windows, k)
    return { times, subcycles: Int32Array.from(times, time => Math.ceil(dt / (time + diffusion))) }
  }
  return none
}
