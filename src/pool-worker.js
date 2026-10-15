/** A worker of the pool: reads the cells of one runoff chunk, or routes the blocks of a job of a network, per task. */
// imported only once the worker takes in its tasks: the kernel's module reads and compiles its WebAssembly as it is
// imported, and a browser hands a module worker the tasks that come meanwhile whether it listens or not
const imported = Promise.all([import('./kernel.js'), import('./runoff.js')])
  .then(([kernel, runoff]) => ({ ...kernel, ...runoff }))

const openArrays = new Map() // array url -> the array, opened once and read by every later task

const TASKS = {
  async readChunkCells(task, { openZarrArray, readChunkCells }) {
    if (!openArrays.has(task.arrayUrl)) openArrays.set(task.arrayUrl, openZarrArray(task.arrayUrl))
    try {
      return await readChunkCells(await openArrays.get(task.arrayUrl), task)
    } catch (error) {
      openArrays.delete(task.arrayUrl) // an array that failed to open is opened again by the next task
      throw error
    }
  },
  route({ network, runoff, blocks, keep }, { routeRivers }) {
    return routeRivers(network, runoff, { blocks, keep })
  },
}

self.onmessage = async ({ data: task }) => {
  try {
    if (!Object.hasOwn(TASKS, task.kind)) throw new Error(`a pool worker has no task ${task.kind}`)
    const result = await TASKS[task.kind](task, await imported)
    self.postMessage({ result }, [result.buffer])
  } catch (error) {
    self.postMessage({ error: `${error.message ?? error}` })
  }
}

// modules that cannot be imported fail the worker, as they did imported first, so that its pool breaks and is replaced
await imported
