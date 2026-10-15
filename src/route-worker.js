/**
 * Routes a hydrograph off the page's thread, with a pool of workers, kept from one route to the next, to read the
 * runoff and route the regions of large networks, and hands it back with the network and runoff it was routed from.
 * Where a worker cannot start workers of its own, it all runs here.
 */
import { createWorkerPool } from './worker-pool.js'

// imported only once the worker takes in its messages: the kernel's module reads and compiles its WebAssembly as it is
// imported, and a browser hands a module worker the messages that come meanwhile whether it listens or not
const imported = import('./routing.js')

const POOL_SIZE = Math.min(navigator.hardwareConcurrency || 4, 8)
let workerPool

function startWorkerPool() {
  if (typeof Worker !== 'function') return undefined
  const createWorker = () => new Worker(new URL('./pool-worker.js', import.meta.url), { type: 'module' })
  return createWorkerPool(createWorker, POOL_SIZE)
}

self.onmessage = async ({ data: inputs }) => {
  try {
    const { routeHydrograph } = await imported
    if (workerPool === undefined || workerPool.isBroken()) {
      await workerPool?.terminate()
      workerPool = startWorkerPool()
    }
    const routed = await routeHydrograph(inputs, workerPool)
    const { times, discharge, riverIds, runoffByCell, network } = routed
    const arrays = [times, discharge, riverIds, runoffByCell, ...Object.values(network).filter(ArrayBuffer.isView)]
    self.postMessage({ routed }, arrays.map(array => array.buffer))
  } catch (error) {
    self.postMessage({ error: `${error.message ?? error}` })
  }
}

// modules that cannot be imported fail the worker, as they did imported first
await imported
