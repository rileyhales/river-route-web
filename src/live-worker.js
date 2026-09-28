/**
 * Routes live, without end: every river of the regions the page loads, an hour of the simulation a step, as many steps
 * a second as the page asks, forced by the runoff the page gives grid cells, as sources and as pulses of its brush,
 * which live-engine.js tells apart. The page's messages wait in a queue that each tick of the loop takes up first; its
 * answers are frames of each river's discharge class after the latest step, of which the page is only ever handed the
 * newest: the next waits until the page hands the last one's buffer back, so that frames never pile up behind a busy
 * page. Each frame carries the time spent making it since the last: taking up the queue, routing, and classing, and the
 * history of each river the page gauges.
 */
import { createLiveEngine } from './live-engine.js'
import { prepareRegion } from './routing.js'

const STEP_SECONDS = 3600 // an hour, each step routed
const TICK_MILLISECONDS = 16 // how often the loop takes up the queue and the clock
const MOST_STEPS_A_TICK = 256 // a tick routes at most this many steps, and lets the time it is behind by go

let engine
let classing // the classes of discharge frames hold, as the page's map draws them
let hoursPerSecond = 24 // until the page sets its own
let playing = true
let frame = new Float32Array(0) // the buffer frames are sent in, which the page hands back
let frameAway = false // whether the page holds the buffer
let frameDue = false // whether the page lacks the latest state
let stepsDue = 0 // the steps the clock has asked for and the loop has not yet routed
let lastTick = performance.now()
let regionLoads = Promise.resolve() // regions load one after another
const queue = [] // the page's messages, waiting for the next tick
let cycle = { queueMs: 0, routeMs: 0, hours: 0 } // the work since the last frame

const TASKS = {
  start({ nX, classes }) {
    engine = createLiveEngine(nX)
    classing = classes
  },
  region(inputs) {
    regionLoads = regionLoads.then(() => loadRegion(inputs))
  },
  runoff({ cellKeys, depthMillimeters }) {
    engine.setRunoff(cellKeys, depthMillimeters / 1000)
  },
  gauges({ riverIds }) {
    engine.setGauges(Array.from(riverIds))
    frameDue = true
  },
  pulse({ underBrush, passedOver, depthMillimeters }) {
    engine.pulse(underBrush, passedOver, depthMillimeters / 1000)
  },
  clear() {
    engine.clearRunoff()
  },
  drain() {
    engine.drain()
    frameDue = true
  },
  rate({ rate }) {
    if (!(rate >= 0)) throw new Error(`the simulation runs at 0 hours a second or more, not ${rate}`)
    hoursPerSecond = rate // 0 holds the simulation still, as pausing does
  },
  play() {
    playing = true
  },
  pause() {
    playing = false
  },
  frame({ classes }) {
    frame = classes
    frameAway = false
  },
}

self.onmessage = ({ data }) => {
  queue.push(data)
}

/** Take up one of the page's messages. */
function takeUp(task) {
  try {
    if (!Object.hasOwn(TASKS, task.kind)) throw new Error(`the live worker has no task ${task.kind}`)
    if (engine === undefined && task.kind !== 'start') throw new Error(`the live worker was given ${task.kind} first`)
    TASKS[task.kind](task)
  } catch (error) {
    self.postMessage({ kind: 'error', message: `${error.message ?? error}` })
  }
}

/** Load a region into the engine, and hand the page the network it makes. */
async function loadRegion({ id, routingParametersUrl, gridWeightsUrl }) {
  try {
    engine.addRegion(id, await prepareRegion({ routingParametersUrl, gridWeightsUrl }, STEP_SECONDS))
    const riverIds = Int32Array.from(engine.riverIds())
    self.postMessage({ kind: 'network', regions: engine.regions(), riverIds }, [riverIds.buffer])
    frameDue = true
  } catch (error) {
    self.postMessage({ kind: 'error', message: `region ${id} could not be loaded: ${error.message ?? error}`, id })
  }
}

/**
 * Take up the queue, route the steps the clock asks for, and hand the page the latest state if it lacks it and holds
 * no frame.
 */
function tick() {
  const started = performance.now()
  const elapsedSeconds = (started - lastTick) / 1000
  lastTick = started
  for (const task of queue.splice(0)) takeUp(task)
  const queueTakenUp = performance.now()
  cycle.queueMs += queueTakenUp - started
  if (engine === undefined || engine.riverIds().length === 0) return
  if (playing) {
    stepsDue += elapsedSeconds * hoursPerSecond * (3600 / STEP_SECONDS)
    const steps = Math.min(Math.floor(stepsDue), MOST_STEPS_A_TICK)
    stepsDue = steps === MOST_STEPS_A_TICK ? 0 : stepsDue - steps
    engine.route(steps)
    cycle.hours += (steps * STEP_SECONDS) / 3600
    frameDue ||= steps > 0
  }
  cycle.routeMs += performance.now() - queueTakenUp
  if (frameDue && !frameAway) sendFrame()
}

function sendFrame() {
  const started = performance.now()
  const classes = engine.dischargeClasses(classing)
  if (frame.length !== classes.length) frame = new Float32Array(classes.length)
  frame.set(classes)
  frameAway = true
  frameDue = false
  const sentAt = performance.timeOrigin + performance.now() // in milliseconds since 1970, a clock the page shares
  const timings = { ...cycle, classesMs: performance.now() - started, sentAt }
  cycle = { queueMs: 0, routeMs: 0, hours: 0 }
  const gauges = engine.gaugeHistory()
  const message = { kind: 'frame', stepsRouted: engine.stepsRouted(), classes: frame, gauges, timings }
  self.postMessage(message, [frame.buffer, gauges.riverIds.buffer, gauges.history.buffer])
}

setInterval(tick, TICK_MILLISECONDS)
