/** A worker of the pool: reads the cells of one runoff chunk, or routes a part of a network, per task. */
import { routeRivers, routeRiversByTimeStep } from './muskingum-wasm.js'
import { openZarrArray, readChunkCells } from './runoff.js'

const openArrays = new Map() // array url -> the array, opened once and read by every later task

const TASKS = {
  async readChunkCells(task) {
    if (!openArrays.has(task.arrayUrl)) openArrays.set(task.arrayUrl, openZarrArray(task.arrayUrl))
    try {
      return await readChunkCells(await openArrays.get(task.arrayUrl), task)
    } catch (error) {
      openArrays.delete(task.arrayUrl) // an array that failed to open is opened again by the next task
      throw error
    }
  },
  route({ order, network, runoffByCell, nSteps }) {
    if (order !== 'river' && order !== 'time') throw new Error(`order must be 'river' or 'time', not ${order}`)
    return (order === 'river' ? routeRivers : routeRiversByTimeStep)(network, runoffByCell, nSteps)
  },
}

self.onmessage = async ({ data: task }) => {
  try {
    if (!Object.hasOwn(TASKS, task.kind)) throw new Error(`a pool worker has no task ${task.kind}`)
    const result = await TASKS[task.kind](task)
    self.postMessage({ result }, [result.buffer])
  } catch (error) {
    self.postMessage({ error: `${error.message ?? error}` })
  }
}
