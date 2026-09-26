/**
 * The player over the map, patterned after webapp-rfs-v3's: a play button, the time and number of the step shown, a
 * slider through the period, and a speed in days of the period a second. It steps a stepper, as startTimeSteps makes
 * one, through the period and hands each step it shows to ``onStep``, with the stepper, which holds every river's
 * discharge after it. A step already routed is never routed again, but a step before the one shown starts the period
 * over. Space plays and pauses, and the arrow keys move a step, while no field, the map, or the chart has the keyboard.
 */
const STEP_COUNT = new Intl.NumberFormat('en-US')
const SECONDS_PER_DAY = 86400

export function createPlayer(onStep) {
  const $ = id => document.getElementById(id)
  const [card, button, slider, speed, timeLabel, stepLabel, progress] = [
    'player', 'btn-play', 'slider', 'speed', 'time-label', 'step-label', 'progress-bar',
  ].map($)
  let run // the stepper, the times of its steps and how many make a day, the step shown, and the steps routed
  let frame // the animation frame requested while playing
  let lastFrameTime
  let stepsDue // the steps of the period that the time played since the last step shown has asked for

  function show(step) {
    const last = run.times.length - 1
    run.step = Math.min(Math.max(step, 0), last)
    if (run.step < run.routed - 1) {
      run.stepper.restart()
      run.routed = 0
    }
    if (run.step >= run.routed) run.routed = run.stepper.advance(run.step + 1 - run.routed)
    onStep(run.step, run.stepper)
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
    /** Play the steps of ``stepper``, at ``times`` in seconds since 1970, from the first. */
    load(times, stepper) {
      pause()
      const stepsPerDay = times.length > 1 ? SECONDS_PER_DAY / (times[1] - times[0]) : 1 // the runoff's steps are even
      run = { times, stepper, stepsPerDay, step: 0, routed: 0 }
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
