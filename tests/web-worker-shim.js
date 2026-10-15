// Runs a browser worker module, named by workerData.module, on a node worker thread: the module sets self.onmessage and
// calls self.postMessage as it would in a browser, and the thread's parent port carries the messages both ways. A
// browser hands a module worker its messages once its modules start running, even while one of them awaits, as the
// kernel's module does while it compiles its WebAssembly, and loses each message that comes before the worker listens.
// The shim holds the messages until the kernel starts compiling, or else until the module is imported, hands them over
// then, and fails the worker on a message that finds no listener, so that a test sees what a browser would lose.
import { parentPort, workerData } from 'node:worker_threads'

globalThis.self = globalThis
globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer)

const held = [] // the messages that come before the worker's modules start running
let running = false

function deliver(data) {
  if (typeof self.onmessage !== 'function') {
    throw new Error(`${workerData.module} was handed a message before it listened, which a browser would lose`)
  }
  self.onmessage({ data })
}

/** Hand over the messages held, each as a task of its own, and every later message as it comes. */
function startRunning() {
  if (running) return
  running = true
  for (const data of held.splice(0)) setImmediate(() => deliver(data))
}

const instantiate = WebAssembly.instantiate
WebAssembly.instantiate = async (...args) => {
  startRunning()
  await new Promise(resolve => setImmediate(resolve)) // so that the messages held are handed over while it compiles
  return instantiate(...args)
}
parentPort.on('message', data => {
  if (running) deliver(data)
  else held.push(data)
})
await import(workerData.module)
startRunning()
