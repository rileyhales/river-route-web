// Runs a browser worker module, named by workerData.module, on a node worker thread: the module sets self.onmessage and
// calls self.postMessage as it would in a browser, and the thread's parent port carries the messages both ways.
import { parentPort, workerData } from 'node:worker_threads'

globalThis.self = globalThis
globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer)
await import(workerData.module)
parentPort.on('message', data => self.onmessage({ data }))
