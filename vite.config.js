import { createReadStream, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { defineConfig } from 'vite'

// a link to the inputs read in place: routing/region=<id>/, network files and grid weights, and forcings/era5/
const DATA_DIRECTORY = resolve(import.meta.dirname, 'data')
const CONTENT_TYPES = new Map([['.json', 'application/json'], ['.parquet', 'application/vnd.apache.parquet']])
const BYTE_RANGE = /^bytes=(\d*)-(\d*)$/ // one range: first-last, first- to the end, or -the last so many bytes

const isInDataDirectory = path => path === DATA_DIRECTORY || path.startsWith(DATA_DIRECTORY + sep)

/**
 * The first and last byte of a file of ``size`` bytes that a Range header asks for, the whole file when there is no
 * header, or undefined when the range cannot be served.
 */
function requestedBytes(rangeHeader, size) {
  if (rangeHeader === undefined) return { first: 0, last: size - 1 }
  const [, first, last] = BYTE_RANGE.exec(rangeHeader) ?? []
  if (first === undefined || (first === '' && last === '')) return undefined
  const bytes = first === ''
    ? { first: Math.max(size - Number(last), 0), last: size - 1 }
    : { first: Number(first), last: last === '' ? size - 1 : Math.min(Number(last), size - 1) }
  return bytes.first <= bytes.last ? bytes : undefined
}

/**
 * Serve data/ at /data/ as plain files, following its links, or one byte range of a file when asked, as the map's
 * PMTiles reader asks. Anything missing answers 404, which a zarr reader takes as a chunk of fill values, rather than
 * the index.html vite falls back to.
 */
function serveDataDirectory() {
  return {
    name: 'serve-data-directory',
    configureServer(server) {
      server.middlewares.use('/data', (request, response) => {
        const path = resolve(DATA_DIRECTORY, `.${decodeURIComponent(new URL(request.url, 'http://host').pathname)}`)
        const stats = isInDataDirectory(path) ? statSync(path, { throwIfNoEntry: false }) : undefined
        const bytes = stats?.isFile() ? requestedBytes(request.headers.range, stats.size) : undefined
        response.setHeader('Access-Control-Allow-Origin', '*')
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405).end()
        } else if (!stats?.isFile()) {
          response.writeHead(404).end()
        } else if (bytes === undefined) {
          response.writeHead(416, { 'Content-Range': `bytes */${stats.size}` }).end()
        } else {
          const partial = request.headers.range !== undefined
          response.writeHead(partial ? 206 : 200, {
            'Content-Type': CONTENT_TYPES.get(extname(path)) ?? 'application/octet-stream',
            'Content-Length': bytes.last - bytes.first + 1,
            'Accept-Ranges': 'bytes',
            ...(partial ? { 'Content-Range': `bytes ${bytes.first}-${bytes.last}/${stats.size}` } : {}),
          })
          if (request.method === 'HEAD' || bytes.last < bytes.first) response.end()
          else createReadStream(path, { start: bytes.first, end: bytes.last })
            .on('error', error => response.destroy(error)).pipe(response)
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [serveDataDirectory()],
  server: { watch: { ignored: [isInDataDirectory] } },
  worker: { format: 'es' },
  build: {
    chunkSizeWarningLimit: 1100, // kB: maplibre-gl alone is about 800 of the page's 1,064
    // both pages: routing live the runoff painted onto the map, and routing a period
    rolldownOptions: { input: ['index.html', 'deterministic.html'].map(page => resolve(import.meta.dirname, page)) },
  },
})
