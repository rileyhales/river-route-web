/**
 * Run tasks on ``size`` workers made by ``createWorker``, one task per worker at a time, in the order given. A worker
 * answers each task with ``{ result }`` or ``{ error }``. A worker that fails, which can happen before it is given any
 * task, as when its module does not load, rejects every task running or waiting, and every task after, since a dead
 * worker never answers.
 */
export function createWorkerPool(createWorker, size) {
  if (!(Number.isInteger(size) && size >= 1)) throw new Error(`a worker pool needs at least one worker, got ${size}`)
  const workers = Array.from({ length: size }, () => {
    const worker = createWorker()
    worker.onerror = event => fail(new Error(`a pool worker failed: ${event.message || 'it did not load'}`))
    return worker
  })
  const idleWorkers = [...workers]
  const waitingTasks = []
  const runningTasks = new Set()
  let failure

  function fail(error) {
    failure ??= error
    for (const task of [...waitingTasks.splice(0), ...runningTasks]) task.reject(failure)
    runningTasks.clear()
  }

  function startWaitingTasks() {
    while (failure === undefined && idleWorkers.length > 0 && waitingTasks.length > 0) {
      const worker = idleWorkers.pop()
      const task = waitingTasks.shift()
      runningTasks.add(task)
      worker.onmessage = ({ data }) => {
        runningTasks.delete(task)
        idleWorkers.push(worker)
        if (data.error === undefined) task.resolve(data.result)
        else task.reject(new Error(data.error))
        startWaitingTasks()
      }
      worker.postMessage(task.message, task.transfer)
    }
  }

  return {
    size,
    run: (message, transfer = []) => new Promise((resolve, reject) => {
      if (failure !== undefined) return reject(failure)
      waitingTasks.push({ message, transfer, resolve, reject })
      startWaitingTasks()
    }),
    isBroken: () => failure !== undefined,
    terminate: () => Promise.all(workers.map(worker => worker.terminate())),
  }
}
