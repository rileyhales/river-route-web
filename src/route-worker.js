/**
 * Routes a hydrograph off the page's thread, with a pool of workers, kept from one route to the next, to read the
 * runoff and route the regions of large networks. Where a worker cannot start workers of its own, it all runs here.
 */
import { routeHydrograph } from './routing.js'
import { createWorkerPool } from './worker-pool.js'

const POOL_SIZE = Math.min(navigator.hardwareConcurrency || 4, 8)
let workerPool

function startWorkerPool() {
  if (typeof Worker !== 'function') return undefined
  const createWorker = () => new Worker(new URL('./pool-worker.js', import.meta.url), { type: 'module' })
  return createWorkerPool(createWorker, POOL_SIZE)
}

self.onmessage = async ({ data: inputs }) => {
  try {
    if (workerPool === undefined || workerPool.isBroken()) {
      await workerPool?.terminate()
      workerPool = startWorkerPool()
    }
    const routed = await routeHydrograph(inputs, workerPool)
    self.postMessage({ routed }, [routed.times.buffer, routed.discharge.buffer])
  } catch (error) {
    self.postMessage({ error: `${error.message ?? error}` })
  }
}
