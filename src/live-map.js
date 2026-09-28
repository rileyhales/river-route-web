/**
 * The live page's map, patterned after webapp-rfs-v3 as the period page's is: the streams, the grid of runoff cells,
 * which a circular brush paints runoff into or erases it from, the painted cells, and every river of the regions loaded
 * colored by its discharge wherever it holds water, with each gauged river outlined in its gauge's color. The grid's
 * lines are drawn, when asked for, once a cell is GRID_CELL_PIXELS wide.
 */
import {
  addStreamsSource, CLASS_COLOR, createBaseMap, DISCHARGE_CLASS, drawDischargeOn, nearestStream, queryStreams,
  readColors, STREAM_ORDER_WIDTH, streamLine,
} from './map.js'

const GRID_CELL_PIXELS = 6 // the grid's lines are drawn only while a cell is at least this many pixels wide
const MOST_GRID_LINES = 2000 // and while no more lines than this cross the view
const NO_REGION = ['in', ['get', 'TDXHydroRegion'], ['literal', []]] // a filter no river passes
const NO_RIVER = ['in', ['get', 'riverId'], ['literal', []]]
const PAINTING_TOOLS = new Set(['pulse', 'source', 'erase'])
const GAUGE_OUTLINE_PIXELS = 2.5
const EMPTY = { type: 'FeatureCollection', features: [] }

/**
 * The evenly spaced grid whose cells ``latitudes`` and ``longitudes`` center: its cells a row, and each cell's key,
 * y nX + x, the cells a circle on the map covers, their outlines, and the lines between cells in view.
 */
export function createGrid({ latitudes, longitudes }) {
  const [nY, nX] = [latitudes.length, longitudes.length]
  const [dy, dx] = [latitudes[1] - latitudes[0], longitudes[1] - longitudes[0]]
  const even = (values, spacing) => values.every((value, index) => {
    return index === 0 || Math.abs(value - values[index - 1] - spacing) <= 1e-6 * Math.abs(spacing)
  })
  if (!(nY > 1 && nX > 1 && dx > 0 && dy !== 0 && even(latitudes, dy) && even(longitudes, dx))) {
    throw new Error('the grid of runoff cells must be evenly spaced, with longitudes increasing')
  }
  const aroundTheGlobe = Math.abs(nX * dx - 360) <= 1e-6 * 360
  const modulo = (value, divisor) => ((value % divisor) + divisor) % divisor
  const rowOf = latitude => Math.round((latitude - latitudes[0]) / dy)
  const columnOf = longitude => {
    const column = Math.round((longitude - longitudes[0]) / dx)
    return aroundTheGlobe ? modulo(column, nX) : column
  }
  const centerOf = (y, x) => [modulo(longitudes[x] + 180, 360) - 180, latitudes[y]]
  return {
    nX,
    /** The pixels a cell is wide at the center of the view of ``map``. */
    cellPixels(map) {
      const { lng, lat } = map.getCenter()
      return Math.abs(map.project([lng + dx, lat]).x - map.project([lng, lat]).x)
    },
    /**
     * The keys of the cells whose centers are within ``radius`` pixels of ``point`` on ``map``, or under it. The map is
     * flat and north up, so a center's pixel row follows from its latitude alone, and its column from its longitude.
     */
    cellsInCircle(map, point, radius) {
      const { lng, lat } = map.unproject(point)
      const [right, below, above] = [[radius, 0], [0, radius], [0, -radius]].map(([x, y]) => {
        return map.unproject([point.x + x, point.y + y])
      })
      const spanX = Math.min(Math.ceil(Math.abs(right.lng - lng) / dx) + 1, Math.ceil(nX / 2))
      const spanY = Math.ceil(Math.max(Math.abs(below.lat - lat), Math.abs(above.lat - lat)) / Math.abs(dy)) + 1
      const [row, column] = [rowOf(lat), columnOf(lng)]
      const [firstY, lastY] = [Math.max(row - spanY, 0), Math.min(row + spanY, nY - 1)]
      const pixelY = Float64Array.from({ length: Math.max(lastY - firstY + 1, 0) }, (_, index) => {
        return map.project([lng, latitudes[firstY + index]]).y
      })
      const keys = []
      for (let offset = -spanX; offset <= spanX; offset++) {
        const x = aroundTheGlobe ? modulo(column + offset, nX) : column + offset
        if (x < 0 || x >= nX) continue
        // the copy of the column, one world over or another, nearest the point, as the map may show several worlds
        const longitude = centerOf(0, x)[0]
        const pixelX = map.project([longitude + 360 * Math.round((lng - longitude) / 360), lat]).x
        for (let y = firstY; y <= lastY; y++) {
          const under = y === row && offset === 0
          if (under || Math.hypot(pixelX - point.x, pixelY[y - firstY] - point.y) <= radius) keys.push(y * nX + x)
        }
      }
      return keys
    },
    /** The outline of the cell ``key``, a ring of longitudes and latitudes. */
    cellRing(key) {
      const [longitude, latitude] = centerOf(Math.floor(key / nX), key % nX)
      const [halfX, halfY] = [dx / 2, Math.abs(dy) / 2]
      const [west, east, south, north] = [longitude - halfX, longitude + halfX, latitude - halfY, latitude + halfY]
      return [[west, south], [east, south], [east, north], [west, north], [west, south]]
    },
    /** The lines between the cells in the view of ``map``, or none when more than MOST_GRID_LINES would cross it. */
    linesInView(map) {
      const bounds = map.getBounds()
      const [south, north] = [Math.max(bounds.getSouth(), -85), Math.min(bounds.getNorth(), 85)]
      const [firstX, firstY] = [longitudes[0] - dx / 2, latitudes[0] - dy / 2] // the edges before the first cells
      const columns = [Math.ceil((bounds.getWest() - firstX) / dx), Math.floor((bounds.getEast() - firstX) / dx)]
      const rows = [(south - firstY) / dy, (north - firstY) / dy].sort((a, b) => a - b)
      const [firstRow, lastRow] = [Math.ceil(rows[0]), Math.floor(rows[1])]
      if (columns[1] - columns[0] + lastRow - firstRow + 2 > MOST_GRID_LINES) return EMPTY
      const line = coordinates => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } })
      const features = []
      for (let edge = columns[0]; edge <= columns[1]; edge++) {
        features.push(line([[firstX + edge * dx, south], [firstX + edge * dx, north]]))
      }
      for (let edge = firstRow; edge <= lastRow; edge++) {
        features.push(line([[bounds.getWest(), firstY + edge * dy], [bounds.getEast(), firstY + edge * dy]]))
      }
      return { type: 'FeatureCollection', features }
    },
  }
}

/**
 * The live map in ``container``, of the streams of the PMTiles archive at ``streamsUrl`` and the cells of ``grid``, as
 * createGrid makes it. The brush's strokes go to ``onStroke``, as paintWithBrush gives them; the tile properties of the
 * stream nearest each click of the gauge tool go to ``onGaugeClicked``; what goes wrong goes to ``onError``.
 */
export async function createLiveMap(container, streamsUrl, grid, { onStroke, onGaugeClicked, onError }) {
  const { map, protocol } = await createBaseMap(container, onError)
  const colors = readColors()
  addStreamsSource(map, protocol, streamsUrl, colors)
  addLiveLayers(map)
  const discharge = drawDischargeOn(map, 'live-discharge', onError)
  const brush = paintWithBrush(map, grid, onStroke)
  const gaugePicker = pickGauges(map, onGaugeClicked)
  panWithMiddleButton(map)
  let gridShown = false // the grid's lines, off unless asked for
  const showGrid = () => map.getSource('grid-lines').setData(gridShown && grid.cellPixels(map) >= GRID_CELL_PIXELS
    ? grid.linesInView(map) : EMPTY)
  map.on('moveend', showGrid)
  return {
    /** Draw the lines between the grid's cells, once a cell is GRID_CELL_PIXELS wide, or stop drawing them. */
    setGridShown(shown) {
      gridShown = shown
      showGrid()
    },
    /**
     * Paint with ``tool``: 'pulse', 'source', 'erase', or 'pan', which moves the map instead, or 'gauge', which moves
     * it and picks the river clicked.
     */
    setTool(tool) {
      brush.setTool(tool)
      gaugePicker.setActive(tool === 'gauge')
    },
    setBrushRadius: brush.setRadius,
    /** Outline each of ``gauges``, a ``riverId`` and a ``color`` each, in its color. */
    setGauges(gauges) {
      const byRiver = gauges.flatMap(({ riverId, color }) => [riverId, color])
      const riverIds = gauges.map(({ riverId }) => riverId)
      map.setFilter('gauges', riverIds.length === 0 ? NO_RIVER : ['in', ['get', 'riverId'], ['literal', riverIds]])
      map.setPaintProperty('gauges', 'line-color', byRiver.length === 0 ? 'rgba(0, 0, 0, 0)'
        : ['match', ['get', 'riverId'], ...byRiver, 'rgba(0, 0, 0, 0)'])
    },
    /** Draw ``painted``, each source cell's key and its runoff depth an hour, in millimeters. */
    showPainted(painted) {
      const features = Array.from(painted, ([key, depth]) => ({
        type: 'Feature', properties: { depth }, geometry: { type: 'Polygon', coordinates: [grid.cellRing(key)] },
      }))
      map.getSource('painted-cells').setData({ type: 'FeatureCollection', features })
    },
    /** Color the rivers ``riverIds``, of the regions ``regionIds``, by the classes drawDischarge is given. */
    setNetwork(riverIds, regionIds) {
      map.setFilter('live-discharge', ['in', ['get', 'TDXHydroRegion'], ['literal', regionIds]])
      const positionOf = new Map(Array.from(riverIds, (riverId, position) => [riverId, position]))
      discharge.start(riverIds, feature => positionOf.get(feature.id), 0)
    },
    /** Draw each river's discharge class, in the order setNetwork was given their ids: how many rivers it redrew. */
    drawDischarge(classValues) {
      return discharge.draw(classValues)
    },
    /** Call ``callback`` once the map next draws a frame on the screen. */
    afterRender(callback) {
      map.once('render', callback)
    },
  }
}

/**
 * The grid's lines, the source cells, colored by their depth, and the discharge of the rivers of the regions loaded,
 * drawn only where a river holds more than the lowest class of discharge: over the network, under the discharge. Over
 * everything, the gauged rivers' outlines, drawn either side of a gap as wide as the river, so that its discharge shows
 * through.
 */
function addLiveLayers(map) {
  map.addSource('grid-lines', { type: 'geojson', data: EMPTY })
  map.addSource('painted-cells', { type: 'geojson', data: EMPTY })
  map.addLayer({
    id: 'grid-lines', type: 'line', source: 'grid-lines',
    paint: { 'line-color': 'rgba(221, 229, 238, 0.18)', 'line-width': 1 },
  })
  const byDepth = ['interpolate', ['linear'], ['get', 'depth'], 1, 0.2, 10, 0.4, 50, 0.65]
  map.addLayer({
    id: 'painted-cells', type: 'fill', source: 'painted-cells',
    paint: { 'fill-color': '#38bdf8', 'fill-opacity': byDepth, 'fill-outline-color': 'rgba(56, 189, 248, 0.8)' },
  })
  map.addLayer(streamLine('live-discharge', {
    'line-color': ['case', ['<=', DISCHARGE_CLASS, 0], 'rgba(0, 0, 0, 0)', CLASS_COLOR],
    'line-width': STREAM_ORDER_WIDTH,
    'line-opacity': 0.95,
  }, NO_REGION))
  map.addLayer(streamLine('gauges', {
    'line-color': 'rgba(0, 0, 0, 0)',
    'line-width': GAUGE_OUTLINE_PIXELS,
    'line-gap-width': STREAM_ORDER_WIDTH,
  }, NO_RIVER))
}

/**
 * While active, a click hands the tile properties of the stream nearest it to ``onGaugeClicked``, and the pointer
 * shows where a click would find one.
 */
function pickGauges(map, onGaugeClicked) {
  let active = false
  map.on('click', event => {
    if (!active) return
    const stream = nearestStream(map, event, ['streams'])
    if (stream !== undefined) onGaugeClicked(stream.properties)
  })
  map.on('mousemove', event => {
    if (active) map.getCanvas().style.cursor = queryStreams(map, event.point, ['streams']).length > 0 ? 'pointer' : ''
  })
  return {
    setActive(nextActive) {
      active = nextActive
      if (!active) map.getCanvas().style.cursor = ''
    },
  }
}

/**
 * A drag with the middle button held moves the map, whatever the tool, so that the brush can paint and the map move
 * without changing tools.
 */
function panWithMiddleButton(map) {
  const MIDDLE_BUTTON = 1
  let heldAt // where the pointer is, in the page, while the middle button is held down over the map

  map.getCanvasContainer().addEventListener('mousedown', event => {
    if (event.button !== MIDDLE_BUTTON) return
    event.preventDefault() // no autoscroll
    heldAt = { x: event.clientX, y: event.clientY }
  })
  window.addEventListener('mousemove', event => {
    if (heldAt === undefined) return
    map.panBy([heldAt.x - event.clientX, heldAt.y - event.clientY], { animate: false })
    heldAt = { x: event.clientX, y: event.clientY }
  })
  window.addEventListener('mouseup', event => {
    if (event.button === MIDDLE_BUTTON) heldAt = undefined
  })
}

/**
 * The brush: a circle following the pointer over the map, which, while the tool pulses, places sources, or erases
 * them, turns the time the button is held into strokes: each frame, and once more as the button is let go, the tool,
 * the cells the brush passed over since the last, the cells under it, while it pulses and is held, and the regions of
 * the rivers it passed over go to ``onStroke``. A drag moves the map instead while the tool paints nothing, as 'pan'
 * and 'gauge' do, and as it is to start.
 */
function paintWithBrush(map, grid, onStroke) {
  const cursor = Object.assign(document.createElement('div'), { className: 'brush-cursor', hidden: true })
  map.getContainer().append(cursor)
  let [tool, radius] = ['pan', 40]
  let heldAt // where the pointer is, while its button is held down with a tool that paints
  let stroke = { cellKeys: new Set(), regions: new Set() } // passed over since the last frame
  const canPaint = () => PAINTING_TOOLS.has(tool)
  const dragToPaint = () => {
    if (canPaint()) map.dragPan.disable()
    else map.dragPan.enable()
  }

  function place(point) {
    cursor.hidden = !canPaint()
    map.getCanvas().style.cursor = cursor.hidden ? '' : 'none'
    const [diameter, left, top] = [2 * radius, point.x - radius, point.y - radius]
    Object.assign(cursor.style, {
      width: `${diameter}px`, height: `${diameter}px`, transform: `translate(${left}px, ${top}px)`,
    })
  }

  /**
   * Pass over the cells, and the regions of the rivers, under the brush along the way from ``from`` to ``to``, at
   * points half the brush's radius apart.
   */
  function passAlong(from, to) {
    const nPoints = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / (radius / 2)))
    for (let along = 1; along <= nPoints; along++) {
      const point = { x: from.x + ((to.x - from.x) * along) / nPoints, y: from.y + ((to.y - from.y) * along) / nPoints }
      for (const key of grid.cellsInCircle(map, point, radius)) stroke.cellKeys.add(key)
      const box = [[point.x - radius, point.y - radius], [point.x + radius, point.y + radius]]
      for (const feature of tool === 'erase' ? [] : map.queryRenderedFeatures(box, { layers: ['streams'] })) {
        const region = feature.properties.TDXHydroRegion
        if (region !== undefined) stroke.regions.add(String(region))
      }
    }
  }

  /** Hand the stroke since the last frame to onStroke, with the cells under a held pulse. */
  function handStroke() {
    const underBrush = tool === 'pulse' && heldAt !== undefined ? grid.cellsInCircle(map, heldAt, radius) : []
    const { cellKeys, regions } = stroke
    stroke = { cellKeys: new Set(), regions: new Set() }
    if (tool === 'pulse' || cellKeys.size > 0) {
      onStroke({ tool, cellKeys: [...cellKeys], underBrush, regions: [...regions] })
    }
  }

  function eachFrame() {
    if (heldAt === undefined) return
    handStroke()
    requestAnimationFrame(eachFrame)
  }

  function letGo() {
    if (heldAt === undefined) return
    heldAt = undefined
    handStroke()
  }

  map.on('mousemove', event => {
    place(event.point)
    if (heldAt === undefined) return
    passAlong(heldAt, event.point)
    heldAt = event.point
  })
  map.on('mousedown', event => {
    if (event.originalEvent.button !== 0 || !canPaint()) return
    heldAt = event.point
    passAlong(heldAt, heldAt)
    requestAnimationFrame(eachFrame)
  })
  window.addEventListener('mouseup', letGo)
  map.getCanvasContainer().addEventListener('mouseleave', () => {
    cursor.hidden = true
    letGo()
  })
  dragToPaint()
  return {
    setTool(nextTool) {
      letGo()
      tool = nextTool
      dragToPaint()
      cursor.hidden = true
    },
    setRadius(pixels) {
      radius = pixels
    },
  }
}
