import { createReadStream, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { defineConfig } from 'vite'

// links to inputs read in place, grid weights as parquet, and expected hydrographs, made by tests/prepare_test_data.py
const DATA_DIRECTORY = resolve(import.meta.dirname, 'data')
const CONTENT_TYPES = new Map([['.json', 'application/json'], ['.parquet', 'application/vnd.apache.parquet']])

const isInDataDirectory = path => path === DATA_DIRECTORY || path.startsWith(DATA_DIRECTORY + sep)

/**
 * Serve data/ at /data/ as plain files, following its links. Anything missing answers 404, which a zarr reader takes as
 * a chunk of fill values, rather than the index.html vite falls back to.
 */
function serveDataDirectory() {
  return {
    name: 'serve-data-directory',
    configureServer(server) {
      server.middlewares.use('/data', (request, response) => {
        const path = resolve(DATA_DIRECTORY, `.${decodeURIComponent(new URL(request.url, 'http://host').pathname)}`)
        const stats = isInDataDirectory(path) ? statSync(path, { throwIfNoEntry: false }) : undefined
        response.setHeader('Access-Control-Allow-Origin', '*')
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405).end()
        } else if (!stats?.isFile()) {
          response.writeHead(404).end()
        } else {
          const contentType = CONTENT_TYPES.get(extname(path)) ?? 'application/octet-stream'
          response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stats.size })
          if (request.method === 'HEAD') response.end()
          else createReadStream(path).on('error', error => response.destroy(error)).pipe(response)
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [serveDataDirectory()],
  server: { watch: { ignored: [isInDataDirectory] } },
  worker: { format: 'es' },
})
