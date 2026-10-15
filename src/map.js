/**
 * The map: a basemap, every stream of a PMTiles archive, and the study area picked on it, the outlet clicked and every
 * river upstream of it, which once routed are colored by their discharge at the step the player shows. Patterned after
 * webapp-rfs-v3: a click takes the stream nearest the pointer; the rivers upstream of a stream are the run of
 * riverIndex the tiles end at it, upstreamCount long, and a river's place in the route of them is its riverIndex less
 * the first's; and discharge is a class in feature state, set only on the routed rivers of the tiles loaded, and only
 * when a river's class changes. Width stays with stream order, so that a change of class updates one paint property.
 */
import { addProtocol, Map as MaplibreMap, NavigationControl, setWorkerUrl } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import { PMTiles, Protocol } from 'pmtiles'

// maplibre looks for its worker beside its own module, where vite does not put it, so vite builds it and names it here
setWorkerUrl(maplibreWorkerUrl)

const BASEMAP_SERVICES = 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas'
const BASEMAP_TILES = ['Base', 'Reference'].map(layer => {
  return `${BASEMAP_SERVICES}/World_Dark_Gray_${layer}/MapServer/tile/{z}/{y}/{x}`
})
const BASEMAP_ATTRIBUTION = 'Esri, HERE, Garmin, © OpenStreetMap contributors, and the GIS User Community'
const SOURCE = 'streams' // the streams' source, whose one layer of lines is also named streams
const LAYERS = ['streams', 'study-area', 'outlet'] // bottom to top
const CLICK_PIXELS = 10 // how far around a click to look for a stream, since a line a few pixels wide is hard to hit
/**
 * The classes discharge is drawn in: perTenfold to each tenfold from lowest, 1 m³/s, up to top, at 10^5 m³/s, the
 * lowest class holding every discharge below it and the top every discharge above it. Finer classes would differ by
 * colors too close for anyone to tell apart, and every class a river crosses costs the map an update: at 5 a tenfold,
 * about 4% of rivers change class an hour, against 7% at 8.
 */
export const DISCHARGE_CLASSES = { lowest: 1, perTenfold: 5, top: 25 }
// A river moves from the class drawn to another only once its discharge is this share of a class past the edge of the
// one drawn, so that a river whose discharge wavers about an edge is not drawn in one class, then the other.
const CLASS_MARGIN = 0.25
// the colors of the classes, lowest to highest and evenly spaced: viridis, which reads on the dark basemap apart from
// the network's blue
const DISCHARGE_COLORS = ['#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#6ece58', '#fde725']
/** A river's discharge class, which drawDischargeOn sets in feature state, or -1 before it sets one. */
const DISCHARGE_CLASS = ['coalesce', ['feature-state', 'dischargeClass'], -1]
const STREAM_ORDER = ['coalesce', ['get', 'strahlerOrder'], 1]
const NO_RIVER = ['in', ['get', 'riverId'], ['literal', []]] // a filter no river passes
const NETWORK_OPACITY = 0.85 // the network's, dimmed to DIMMED_NETWORK_OPACITY while discharge is drawn over it
const DIMMED_NETWORK_OPACITY = 0.35

/** The linear-gradient of the discharge classes' colors, for the legend. */
export const dischargeGradient = () => `linear-gradient(90deg, ${DISCHARGE_COLORS.join(', ')})`

/** The color ``hex``, as #rrggbb, at ``opacity``, from 0 to 1. */
function withOpacity(hex, opacity) {
  if (!/^#[0-9a-f]{6}$/i.test(hex) || !(opacity >= 0 && opacity <= 1)) {
    throw new Error(`a color is #rrggbb at an opacity from 0 to 1, not ${hex} at ${opacity}`)
  }
  const [red, green, blue] = [1, 3, 5].map(start => Number.parseInt(hex.slice(start, start + 2), 16))
  return `rgba(${red}, ${green}, ${blue}, ${opacity})`
}

const byZoom = stops => ['interpolate', ['linear'], ['zoom'], ...stops]
const byOrder = (smallest, largest) => ['interpolate', ['linear'], STREAM_ORDER, 1, smallest, 12, largest]
// the lowest class's color half transparent, for the rivers of the lowest class or none, which hold so little they read
// as dry
const DRY_COLOR = withOpacity(DISCHARGE_COLORS[0], 0.5)
/**
 * A river's color by its discharge class, from the lowest class's to the top's: DRY_COLOR in the lowest class, and
 * before it is given a class.
 */
export const CLASS_COLOR = ['case', ['<=', DISCHARGE_CLASS, 0], DRY_COLOR, [
  'interpolate', ['linear'], DISCHARGE_CLASS, ...DISCHARGE_COLORS.flatMap((color, index) => {
    return [(index * DISCHARGE_CLASSES.top) / (DISCHARGE_COLORS.length - 1), color]
  }),
]]
/** A river's width by its stream order, from the smallest, order 1, to order 12, larger than any, and by zoom. */
export const STREAM_ORDER_WIDTH = byZoom([3, byOrder(1, 4.5), 9, byOrder(1.8, 9), 14, byOrder(3.5, 14)])

/** A layer of the streams source's lines, drawn only where ``filter``, when given, passes. */
export function streamLine(id, paint, filter) {
  return {
    id, type: 'line', source: SOURCE, 'source-layer': SOURCE, ...(filter === undefined ? {} : { filter }),
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint,
  }
}

/**
 * The reach a clicked stream's tile properties describe: its river id, its region, and the run of riverIndex that it
 * and every river upstream of it fill, which ends at it.
 */
export function readReach({ riverId, riverIndex, upstreamCount, TDXHydroRegion }) {
  const reach = {
    riverId: Number(riverId), region: String(TDXHydroRegion ?? ''),
    first: Number(riverIndex) - Number(upstreamCount), last: Number(riverIndex),
  }
  if (![reach.riverId, reach.first, reach.last].every(Number.isInteger) || reach.region === '' || reach.first < 0) {
    throw new Error('the stream clicked has no riverId, riverIndex, upstreamCount, and TDXHydroRegion in its tile')
  }
  return reach
}

/**
 * The map in ``container``, drawing the streams of the PMTiles archive at ``streamsUrl``, handing the tile properties
 * of the stream nearest each click to ``onStreamClicked``, and what goes wrong reading the streams or drawing on them
 * to ``onError``. Resolves once the basemap's style has loaded.
 */
export async function createRiverMap(container, streamsUrl, { onStreamClicked, onError }) {
  const { map, protocol } = await createBaseMap(container, onError)
  const colors = readColors()
  addStreams(map, protocol, streamsUrl, colors)
  const discharge = drawDischargeOn(map, 'study-area', onError)
  let studyArea // the reach shown as the study area
  map.on('click', event => {
    const stream = nearestStream(map, event, LAYERS)
    if (stream !== undefined) onStreamClicked(stream.properties)
  })
  map.on('mousemove', event => {
    map.getCanvas().style.cursor = queryStreams(map, event.point, LAYERS).length > 0 ? 'pointer' : ''
  })
  return {
    /** Draw ``reach``, as readReach reads it, as the study area, or none when it is undefined, and stop discharge. */
    showStudyArea(reach) {
      studyArea = reach
      discharge.stop()
      const inRun = reach === undefined ? NO_RIVER
        : ['all', ['>=', ['get', 'riverIndex'], reach.first], ['<=', ['get', 'riverIndex'], reach.last]]
      map.setFilter('study-area', inRun)
      map.setFilter('outlet', reach === undefined ? NO_RIVER : ['==', ['get', 'riverId'], reach.riverId])
    },
    /** Color the study area's rivers, routed as ``riverIds`` in riverIndex order, by the classes drawDischarge has. */
    startDischarge(riverIds) {
      if (studyArea === undefined) throw new Error('discharge is drawn only on a study area')
      const { first, last } = studyArea
      if (riverIds.length !== last - first + 1) {
        throw new Error(`the route has ${riverIds.length} rivers, but the study area's rivers in the tiles number `
          + `${last - first + 1}: the tiles and the routing parameters describe different rivers`)
      }
      discharge.start(riverIds, feature => feature.properties.riverIndex - first, -1)
    },
    /**
     * Draw each routed river's discharge class, as DISCHARGE_CLASSES counts them, in the order startDischarge was given
     * their ids.
     */
    drawDischarge(classValues) {
      discharge.draw(classValues)
    },
    /** Draw the streams of another PMTiles archive, with no study area. */
    setStreams(url) {
      studyArea = undefined
      discharge.stop()
      for (const layer of [...LAYERS].reverse()) map.removeLayer(layer)
      map.removeSource(SOURCE)
      addStreams(map, protocol, url, colors)
    },
  }
}

/**
 * A map in ``container`` over the basemap, flat and north up, which reads PMTiles, handing whatever goes wrong, from
 * reading a source to a layer it cannot draw, to ``onError``: the map and its PMTiles protocol, once the basemap's
 * style has loaded.
 */
export async function createBaseMap(container, onError) {
  const protocol = new Protocol()
  addProtocol('pmtiles', protocol.tile)
  const map = new MaplibreMap({
    container,
    style: basemapStyle(),
    center: [0, 20],
    zoom: 1.6,
    hash: 'map',
    maxZoom: 13,
    // flat and north up, since nothing here reads better tilted or turned, and a turned view makes a river harder to
    // aim at
    maxPitch: 0,
    pitchWithRotate: false,
    touchPitch: false,
    dragRotate: false,
  })
  map.touchZoomRotate.disableRotation()
  map.keyboard.disableRotation()
  map.addControl(new NavigationControl({ showCompass: false }), 'top-left')
  map.on('error', event => {
    onError(event.error ?? new Error(`the map could not read ${event.sourceId ?? 'its data'}`))
  })
  // style.load rather than load, which waits on every tile of the first frame and so on the slowest tile server
  await new Promise(resolve => map.once('style.load', resolve))
  return { map, protocol }
}

/** The dark gray canvas of Esri, with its labels over it, as webapp-rfs-v3's gray-dark basemap. */
function basemapStyle() {
  const sources = Object.fromEntries(BASEMAP_TILES.map((tiles, index) => [`basemap-${index}`, {
    type: 'raster', tiles: [tiles], tileSize: 256, maxzoom: 16, attribution: BASEMAP_ATTRIBUTION,
  }]))
  const layers = Object.keys(sources).map(source => ({ id: source, type: 'raster', source }))
  return { version: 8, sources, layers }
}

/** The map's colors, as tokens.css defines them. */
export function readColors() {
  const style = getComputedStyle(document.documentElement)
  const colors = Object.fromEntries(['stream', 'upstream', 'outlet'].map(name => {
    return [name, style.getPropertyValue(`--${name}`).trim()]
  }))
  const missing = Object.keys(colors).filter(name => colors[name] === '')
  if (missing.length > 0) throw new Error(`the page's styles define no ${missing.map(name => `--${name}`).join(', ')}`)
  return colors
}

/**
 * The url of the streams archive the data sources choose: their streams source, ``streams``, with the archive
 * ``streamsArchive`` in place of its {streams}. The archives hold the same streams, shown from different zooms.
 */
export function streamsUrl({ streams, streamsArchive }) {
  if (!streams.includes('{streams}')) {
    throw new Error(`the streams source ${streams} must name the archive by {streams}`)
  }
  if (typeof streamsArchive !== 'string' || streamsArchive === '') throw new Error('no streams archive is chosen')
  return streams.replaceAll('{streams}', streamsArchive)
}

/** The streams source of the PMTiles archive at ``url``, each line's id its riverId, and the network's layer. */
export function addStreamsSource(map, protocol, url, colors) {
  protocol.add(new PMTiles(url))
  map.addSource(SOURCE, { type: 'vector', url: `pmtiles://${url}`, promoteId: { streams: 'riverId' } })
  map.addLayer(streamLine('streams', {
    'line-color': colors.stream, 'line-width': byZoom([3, 0.7, 9, 1.4, 14, 3]), 'line-opacity': NETWORK_OPACITY,
  }))
}

/**
 * The streams source and its three layers: the network, the study area over it, colored by discharge once routed and
 * amber until then, and the outlet over both.
 */
function addStreams(map, protocol, url, colors) {
  addStreamsSource(map, protocol, url, colors)
  map.addLayer(streamLine('study-area', {
    'line-color': ['case', ['<', DISCHARGE_CLASS, 0], colors.upstream, CLASS_COLOR],
    'line-width': STREAM_ORDER_WIDTH,
    'line-opacity': 0.95,
  }, NO_RIVER))
  const outletWidth = byZoom([3, 5.5, 9, 10, 14, 16])
  map.addLayer(streamLine('outlet', { 'line-color': colors.outlet, 'line-width': outletWidth }, NO_RIVER))
}

/** The rendered features of the streams' ``layers`` in a box of CLICK_PIXELS around ``point``. */
export function queryStreams(map, { x, y }, layers) {
  const box = [[x - CLICK_PIXELS, y - CLICK_PIXELS], [x + CLICK_PIXELS, y + CLICK_PIXELS]]
  return map.queryRenderedFeatures(box, { layers })
}

/**
 * The stream clicked: of those of ``layers`` near the click, the one whose line passes closest to it, rather than
 * whichever is drawn on top, as webapp-rfs-v3's nearestFeature picks. Distances are compared in a plane scaled for the
 * click's latitude.
 */
export function nearestStream(map, { point, lngLat }, layers) {
  const scale = Math.cos((lngLat.lat * Math.PI) / 180)
  let nearest
  let nearestDistance = Infinity
  for (const feature of queryStreams(map, point, layers)) {
    const { type, coordinates } = feature.geometry
    const lines = type === 'LineString' ? [coordinates] : type === 'MultiLineString' ? coordinates : []
    const distance = Math.min(...lines.map(line => squaredDistanceToLine(line, lngLat, scale)))
    if (nearest === undefined || distance < nearestDistance) [nearest, nearestDistance] = [feature, distance]
  }
  return nearest
}

/** The squared distance from ``lngLat`` to the nearest point of ``line``, with longitudes scaled by ``scale``. */
function squaredDistanceToLine(line, { lng, lat }, scale) {
  let nearest = Infinity
  for (let vertex = 0; vertex < line.length; vertex++) {
    const [ax, ay] = line[Math.max(vertex - 1, 0)]
    const [bx, by] = line[vertex]
    const [dx, dy] = [(bx - ax) * scale, by - ay]
    const length = dx * dx + dy * dy
    // where along the segment the click falls, kept to its ends so the answer stays on the stream
    const along = length > 0 ? Math.max(0, Math.min(1, (((lng - ax) * scale * dx) + (lat - ay) * dy) / length)) : 0
    const [px, py] = [(lng - ax - (bx - ax) * along) * scale, lat - ay - (by - ay) * along]
    nearest = Math.min(nearest, px * px + py * py)
  }
  return nearest
}

/**
 * Discharge drawn as a class in feature state on the routed rivers of ``layer`` that the tiles loaded hold, found again
 * whenever tiles load or the view moves, so that the rivers panned away from are no longer drawn. Each step drawn sets
 * state only on the rivers found whose class it moves, by CLASS_MARGIN, past the one drawn. What goes wrong goes to
 * ``onError``.
 */
export function drawDischargeOn(map, layer, onError) {
  // the route's river ids and how to find a river's position among them, each river's class drawn and the last search
  // that found it, and the rivers that search found
  let drawing
  let classValues // each routed river's class at the step drawn, unrounded, in routing order
  let findScheduled = false

  /** Draw the rivers found whose class has moved past the one drawn, and return how many. */
  function drawFound() {
    let nDrawn = 0
    for (const position of drawing.found) {
      const drawn = drawing.drawnClasses[position]
      if (drawn >= 0 && Math.abs(classValues[position] - drawn) < 0.5 + CLASS_MARGIN) continue
      drawing.drawnClasses[position] = Math.round(classValues[position])
      const target = { source: SOURCE, sourceLayer: SOURCE, id: drawing.riverIds[position] }
      map.setFeatureState(target, { dischargeClass: drawing.drawnClasses[position] })
      nDrawn++
    }
    return nDrawn
  }

  /**
   * Find the routed rivers the tiles loaded now hold, each where the route's locate puts it, and draw them, returning
   * how many were drawn.
   */
  function findRivers() {
    findScheduled = false
    if (drawing === undefined || classValues === undefined) return 0
    drawing.searches++
    const found = []
    for (const feature of map.querySourceFeatures(SOURCE, { sourceLayer: SOURCE, filter: map.getFilter(layer) })) {
      const position = drawing.locate(feature)
      if (drawing.lastSearches[position] === drawing.searches) continue // found already in another tile
      if (drawing.riverIds[position] !== feature.id) {
        stop()
        onError(new Error(`river ${feature.id} of the tiles is not the river routed where it is found: the tiles and `
          + 'the routing parameters describe different rivers'))
        return 0
      }
      drawing.lastSearches[position] = drawing.searches
      found.push(position)
    }
    drawing.found = found
    return drawFound()
  }

  function scheduleFinding() {
    if (drawing === undefined || findScheduled) return
    findScheduled = true
    requestAnimationFrame(findRivers)
  }

  function stop() {
    drawing = undefined
    classValues = undefined
    map.removeFeatureState({ source: SOURCE, sourceLayer: SOURCE })
    map.setPaintProperty('streams', 'line-opacity', NETWORK_OPACITY)
  }

  /**
   * Draw the rivers ``riverIds``, finding a feature of the tiles at the position ``locate(feature)`` gives, each river
   * drawn in ``unsetClass`` until drawn in another: -1, before any, or 0, the class of a river holding next to no
   * water.
   */
  function start(riverIds, locate, unsetClass) {
    stop()
    drawing = {
      riverIds,
      locate,
      drawnClasses: new Int16Array(riverIds.length).fill(unsetClass),
      lastSearches: new Int32Array(riverIds.length),
      searches: 0,
      found: [],
    }
    map.setPaintProperty('streams', 'line-opacity', DIMMED_NETWORK_OPACITY)
  }

  /** Draw ``values``, each river's class, and return how many rivers' state it set. */
  function draw(values) {
    if (drawing === undefined) return 0 // stopped, as by a problem already handed to onError, until the next start
    if (values.length !== drawing.riverIds.length) {
      throw new Error(`the classes of ${values.length} rivers cannot be drawn on ${drawing.riverIds.length}`)
    }
    const first = classValues === undefined
    classValues = values
    return first ? findRivers() : drawFound()
  }

  map.on('sourcedata', event => {
    if (event.sourceId === SOURCE && event.tile !== undefined) scheduleFinding()
  })
  map.on('moveend', scheduleFinding)
  return { start, draw, stop }
}
