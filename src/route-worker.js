/**
 * Routes a hydrograph off the page's thread, with a pool of workers, kept from one route to the next, to read the
 * runoff and route the regions of large networks, and hands it back with the network and runoff it was routed from.
 * Where a worker cannot start workers of its own, it all runs here.
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
    const { times, discharge, riverIds, runoffByCell, network } = routed
    self.postMessage({ routed }, [times, discharge, riverIds, runoffByCell, ...Object.values(network)].map(array => {
      return array.buffer
    }))
  } catch (error) {
    self.postMessage({ error: `${error.message ?? error}` })
  }
}
