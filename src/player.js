/**
 * The player over the map, patterned after webapp-rfs-v3's: a play button, the time and number of the step shown, a
 * slider through the period, and a speed in days of the period a second. It routes the period's network a window of
 * steps at a time with kernel.js's startWindows, routing the window that holds each step it shows when that window is
 * not routed yet, and hands the step to ``onStep`` with every river's discharge at its end. A window is routed again
 * only when a step before the window routed last is shown, which starts the period over. Space plays and pauses, and
 * the arrow keys move a step, while no field, the map, or the chart has the keyboard.
 */
import { startWindows } from './kernel.js'

const STEP_COUNT = new Intl.NumberFormat('en-US')
const SECONDS_PER_DAY = 86400
const STEPS_PER_WINDOW = 64 // a window of the Amazon's 237,718 rivers holds 62 MB of their discharge

export function createPlayer(onStep) {
  const $ = id => document.getElementById(id)
  const [card, button, slider, speed, timeLabel, stepLabel, progress] = [
    'player', 'btn-play', 'slider', 'speed', 'time-label', 'step-label', 'progress-bar',
  ].map($)
  // the stepper and the runoff it routes, the times of its steps and how many make a day, the step shown, the first
  // step and count of steps of the window routed last, and every river's discharge at the end of the step shown
  let run
  let frame // the animation frame requested while playing
  let lastFrameTime
  let stepsDue // the steps of the period that the time played since the last step shown has asked for

  /** Route the window that holds ``step``, from the first step of the period again when it comes before the last. */
  function routeWindowOf(step) {
    if (step < run.windowFirst) {
      run.stepper.setChannelState(new Float32Array(run.stepper.channelState().length))
      ;[run.windowFirst, run.windowSteps] = [0, 0]
    }
    while (step >= run.windowFirst + run.windowSteps) {
      run.windowFirst += run.windowSteps
      run.windowSteps = Math.min(STEPS_PER_WINDOW, run.times.length - run.windowFirst)
      run.stepper.copyRunoff(run.runoff, run.windowFirst, run.windowSteps)
      run.stepper.route(run.windowSteps)
    }
  }

  function show(step) {
    const last = run.times.length - 1
    run.step = Math.min(Math.max(step, 0), last)
    routeWindowOf(run.step)
    onStep(run.step, run.stepper.dischargeAt(run.step - run.windowFirst, run.discharge))
    slider.value = String(run.step)
    timeLabel.textContent = `${new Date(run.times[run.step] * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`
    stepLabel.textContent = `${STEP_COUNT.format(run.step + 1)}/${STEP_COUNT.format(last + 1)}`
    progress.style.width = `${(100 * (run.step + 1)) / (last + 1)}%`
  }

  function playFrame(time) {
    stepsDue += ((time - lastFrameTime) / 1000) * Number(speed.value) * run.stepsPerDay
    lastFrameTime = time
    if (stepsDue >= 1) {
      show(run.step + Math.floor(stepsDue))
      stepsDue -= Math.floor(stepsDue)
    }
    if (run.step < run.times.length - 1) frame = requestAnimationFrame(playFrame)
    else pause()
  }

  function play() {
    if (run === undefined || frame !== undefined) return
    if (run.step === run.times.length - 1) show(0)
    button.textContent = '❚❚'
    button.setAttribute('aria-label', 'Pause')
    lastFrameTime = performance.now()
    stepsDue = 0
    frame = requestAnimationFrame(playFrame)
  }

  function pause() {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    button.textContent = '▶'
    button.setAttribute('aria-label', 'Play')
  }

  button.addEventListener('click', () => (frame === undefined ? play() : pause()))
  slider.addEventListener('input', () => {
    pause()
    show(Number(slider.value))
  })
  document.addEventListener('keydown', event => {
    const typing = event.target.closest?.('input, select, textarea, button') != null
    if (run === undefined || typing || event.defaultPrevented) return
    // the arrow keys are the map's, to pan it, and the chart's, to read it, while either has the keyboard
    const arrowsTaken = event.target.closest?.('#map, svg') != null
    if (event.code === 'Space') {
      event.preventDefault()
      if (frame === undefined) play()
      else pause()
    } else if ((event.code === 'ArrowRight' || event.code === 'ArrowLeft') && !arrowsTaken) {
      event.preventDefault()
      pause()
      show(run.step + (event.code === 'ArrowRight' ? 1 : -1))
    }
  })
  return {
    /**
     * Play the route of ``network`` from ``runoffByCell``, each cell's runoff at ``times`` in seconds since 1970, from
     * the first step.
     */
    load(times, network, runoffByCell) {
      pause()
      const stepsPerDay = times.length > 1 ? SECONDS_PER_DAY / (times[1] - times[0]) : 1 // the runoff's steps are even
      const runoff = { depth: runoffByCell, nSteps: times.length }
      const nCells = runoffByCell.length / times.length
      const stepper = startWindows(network, { nCells, stepsPerWindow: STEPS_PER_WINDOW })
      const discharge = new Float32Array(network.subReachStarts.length - 1)
      run = { stepper, runoff, times, stepsPerDay, step: 0, windowFirst: 0, windowSteps: 0, discharge }
      slider.max = String(times.length - 1)
      slider.disabled = false
      card.classList.add('ready')
      show(0)
    },
    /** Stop, with no period to play. */
    clear() {
      pause()
      run = undefined
      slider.value = '0'
      slider.max = '0'
      slider.disabled = true
      timeLabel.textContent = '—'
      stepLabel.textContent = '–/–'
      progress.style.width = '0'
      card.classList.remove('ready')
    },
  }
}
