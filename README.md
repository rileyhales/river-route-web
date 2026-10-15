# river-route-web

river-route's Muskingum routing with static coefficients for the browser, with the uniform runoff transform and every
river starting from no discharge, at a routing step of 3600 s: every river too long or too short for it is split into
sub-reaches or routed in subcycles, as river-route routes with use_subreaches and use_subcycles, and a river of x above
0.49 is refused. The kernel is river-route's own, its npm package `river-route`, and `src/prepare.js` ports the setup
that settles every decision of a run, the sub-reaches and the coefficients, from its Python under the same names.

The page is a map of every stream, patterned after webapp-rfs-v3. Clicking a river picks the study area, that river and
every river upstream of it; the panel then routes it over the time period chosen, reading its inputs over HTTP, and the
player plays every river's discharge on the map a step at a time while the panel draws the outlet's hydrograph. The
reset button in the panel's header clears the study area and its route, keeping the period and the data sources.

| Input              | Format                                                                                         |
|--------------------|------------------------------------------------------------------------------------------------|
| Network file       | river-route's parquet, read for `riverId`, `nextRiverId`, `muskingumK`, `muskingumX`           |
| Grid weights       | parquet with `riverId`, `x_index`, `y_index`, `area_sqm`, `proportion`, as in the netCDF       |
| Runoff             | one (time, y, x) zarr array of runoff depths a year, v2 or v3, like `.../era5_1940.zarr/ro`    |
| Streams            | PMTiles of the streams, with `riverId`, `riverIndex`, `upstreamCount`, and `TDXHydroRegion`    |

The data sources dialog, the cog in the panel's header, names each input by a url, in which `{region}` stands for the
study area's region, `{year}` for each year of the period, and `{streams}` for the streams archive its Stream density
chooses: `streams_thinner`, `streams`, or `streams_denser`, the same streams in the same folder, shown thinner or denser
at each zoom. Runoff is read one zarr a year, so its url must name `{year}`, and each year's array must hold only that
year and go on from the step after the last year's ends, on the same grid. Its time coordinate is the array named by
its first dimension, beside it in the store; its steps must be uniform, and its units attribute one river-route reads
(m, mm, kg m-2), or absent for meters. Only the chunks holding the cells of the routed catchments are read.

## Running

```bash
npm install
npm run dev        # the pages, reading the data/ link at /data/, at the address vite prints, and /live.html
npm run build      # the pages in dist/, to deploy at /webroute/, reading the data sources of .env
npm run preview    # serves dist/ at /webroute/ of the address vite prints, as it is deployed
npm test           # starts its own server, routes the test data, and checks every way it routes agrees
npm run benchmark  # times each stage, in one thread and with pools of workers, and the routing alone
```

`npm install` installs the kernel, river-route's WebAssembly, from npm as the package `river-route`, version 3.

The data sources each page starts with come from `.env`, which a build reads: each region's network file and grid
weights and the streams from the hydrography's CloudFront, and the runoff from `v3.s3.riverforecastsystem.com`, whose
years from 1940 to 2024 bound the period. The dev server reads `.env.development` instead, which names every input in
the `data/` it serves, whose ERA5 runoff, from 1940 to 1944, bounds the period.

The dev server serves `data/` at `/data/` as plain files, following links, which is how the inputs are read in place.
`data/` is a link to `~/river-forecast-system-v3`, a folder laid out as the CloudFront lays it out:

```bash
ln -s ~/river-forecast-system-v3 data
```

It holds `routing/region=<id>/` with each region's `network.parquet` and `gridweights_ERA5_<id>.parquet`,
`forcings/era5/<year>.zarr`, and `hydrography/global/` with the streams archives. The tests route region 7020014250,
the Columbia, with the runoff of 1940 and 1941. The dev server answers a request for a byte range of a file, as the
PMTiles reader asks.

## How it routes

The page hands the inputs to a worker, which reads the two parquet files and the metadata of each year's runoff array at
once, keeps the rivers upstream of the target, and reads their cells' runoff over the period chunk by chunk on a pool of
workers. The pool then routes the network's jobs at once, the sub-watershed blocks that river-route's `assignBlocks`
packs for one worker each, as river-route's Python packs them for its threads, each worker given only its blocks'
weights and its cells' runoff. The page's worker then routes the main stem the blocks drain into from the series of the
blocks' outlets. Each river is routed over a window of steps before the next river, reading its inflow from the
discharge of the rivers draining into it, and only the target's series is kept, so the memory routing takes is one
window of every river's discharge however long the period.

The worker hands the page what it routed, the network and its runoff, and the player routes it again in the page's own
thread a window of 64 steps at a time with the stepper of `river-route`, routing the window that holds each step it
shows when that window is not routed yet, so that a period of any length is never held as every river's discharge at
every step. `src/discharge-classes.js` then classes every river's discharge, 5 classes to each tenfold from 1 m³/s or
less up to 10⁵ m³/s or more: 2.0 ms a step for the Amazon's 237,718 rivers. Every river of the lowest class, 1 m³/s or
less, is drawn in its color half transparent, as dry, on both pages. Finer classes would differ by colors too
close to tell apart, and every class a river crosses costs the map an update: at 5 a tenfold, about 4% of rivers change
class an hour, against 7% at 8. The map draws classes as feature state, as webapp-rfs-v3 animates its forecasts, on only
the routed rivers the tiles in view hold, found again as tiles load and the view moves, and a step sets state only on a
river whose discharge has moved a quarter of a class past the edge of the class drawn, so that a river near an edge does
not flicker between two. Each river is as wide as its stream order, so a change of class updates only its color. A study
area is highlighted before it is routed by the run of `riverIndex` that every river upstream of an outlet fills in the
tiles, ending at it, and each routed river is found in the tiles at its `riverIndex` less the run's first, since routing
parameters list rivers in `riverIndex` order.

## Routing live

`live.html`, a second page, beside the first and linked from its header, routes runoff that a brush gives the map
instead of runoff read from zarr. The brush is a circle over the grid of runoff cells, whose lines the Runoff grid box
draws once zoomed in far enough to see them, and it gives each cell whose center it covers runoff of the intensity
chosen, up to 250 mm an hour, two ways. Pulse, held down, gives it to the cells under the brush every hour of the
simulation while they stay under it, and once to each cell it passed over during the hour, so that a click gives one
pulse and a drag rains along its way; Source makes the cells it passes over give it every hour until Erase takes them
away; Pan, the tool the page starts on, moves the map. The grid is the one that a runoff array's latitudes and
longitudes center, a quarter degree for ERA5, and any evenly spaced grid serves as well, with grid weights made for it.

The routing goes on until it is stopped. A worker, `src/live-worker.js`, routes every river of the regions loaded an
hour at a time, as many hours a second as the page asks, with the stepper of `river-route` in windows of up to 32 steps,
writing the runoff depth that sources and pulses give the cells of the regions' grid weights into each window rather
than reading it from runoff arrays. The page's messages, the pulses, the sources placed and erased, the regions to
load, and the rate, wait in a queue that each tick of the worker takes up first. Its answers are frames of every
river's discharge class after the latest step, and the page is only ever handed the newest: the next frame waits until
the page has drawn the last and handed its buffer back, so that frames never pile up behind a busy page. The panel
shows the map updates of the last second: how many there were, and the mean milliseconds of each stage of one, from
taking up the queue, routing, and classing discharge in the worker, to handing the frame to the page, drawing it as
feature state, and the map drawing it on the screen, and their sum.

A region loads the first time the brush passes over one of its rivers, and its rivers join the network after those of
the regions before, each keeping the discharge of every one of its sub-reaches, so that routing goes on undisturbed.
`src/live-engine.js` gives each source's and pulse's runoff to the rivers whose catchments it covers, by the region's
grid weights, and the map draws every river of the regions loaded over the network. The reset in the header erases every source, stops every pulse, and empties every river. The stop button,
beside play, ends the worker and forgets everything it routed: the sources, the regions loaded, and the gauges. Play,
the brush, or a gauge then starts another worker routing from nothing. The speed runs from 0 to 10×, 240 hours a
second. The dialog's runoff grid and streams, when changed, start the page over from an address naming every source.

Monitoring points, the tool of the Monitoring Points section, gauges the river clicked, loading its region if it is not
loaded, and outlines it on the map in its gauge's color; clicking it again, or its ✕ in the list, removes it. Up to six
rivers are gauged at once. The engine records each gauge's discharge every step, keeping only the last 720, a month of
hours, and each frame carries that history, which the chart draws with the newest step at its right edge, so that a
flood wave passes across it and out. The reset forgets the gauges' history and keeps the gauges.

## The kernel

The kernel is river-route's, the npm package `river-route`, which holds only the WebAssembly: the C of
`river_route/kernels/c`, the kernel river-route's Python routes with, compiled from its `wasm/` folder.
river-route-web's `src/kernel.js` lays its arrays out in the module's memory and calls it, and `src/prepare.js` settles
every decision of a run as river-route's Python does, under the same names. Each river is routed as its sub-reaches, in
place in its own row of discharge, each with coefficients of its own and its share of the river's runoff, and the
subcycles of a river too short for the step are folded into its coefficients, so that every sub-reach takes one step per
runoff step. A river reads its inflow from the rows of the rivers draining directly into it. Nothing compares `kernel.js` and `prepare.js`
with river-route's Python.

The C computes in float32 with 128 bit vectors, as river-route computes in float32. Each sub-reach's recurrence is
solved eight steps at a time, two vectors of four, by a prefix scan, so that only one multiply and add per eight steps
waits on the step before. It is built twice: `routing-relaxed.wasm` uses WebAssembly's relaxed SIMD, whose multiply and
add are fused, and `routing.wasm` does not, for browsers without it. The page takes whichever the browser compiles.

Everything routes river-first: each river over a window of steps before the next river, and every river over a window
before the next window, so the module holds one window of the runoff and of every river's discharge. `routeRivers`
routes a period and keeps the series of only the rivers `keep` names, of only `blocks` of rivers when given them, from
the series `given` of the rivers they drain from, as the pool's main stem is routed. The stepper `startWindows` routes a
window at a time for the player and the live page: its caller writes each window's runoff depth, or copies it from a
period's runoff, and reads every river's discharge at any step of the window, or one river's at every step, and the
discharge of every sub-reach, which carries a network's state into another.

The C follows NASA's rules for C: it allocates nothing, loops over counts it checks, checks every argument and returns a
code naming any problem. river-route builds the published package with `build.py --wasm --checks`, which compiles it
with every warning of clang an error and runs clang-tidy and clang's static analyzer on it. Routing is
split into calls of 256 rivers, since browsers swap in a function's optimized code only between calls: in one call, the
first route in each worker ran at a third of the speed.

## Speed

Routing the Columbia above its mouth, 29,405 rivers, each one reach at the fixed step of 3600 s, as river-route-web
routed before it split rivers into sub-reaches and subcycles, through the 8,777
hours of 1940, on an M3 Max, the average of two routes after a first:

| where      | inputs | runoff | routing | total  |
|------------|--------|--------|---------|--------|
| one thread | 56 ms  | 110 ms | 99 ms   | 264 ms |
| 8 workers  | 47 ms  | 72 ms  | 39 ms   | 159 ms |

The routing alone, in one thread, with relaxed SIMD:

| routing                                                                   | WebAssembly |
|---------------------------------------------------------------------------|-------------|
| `routeRivers`, keeping the outlet's series                                | 98 ms       |
| `startWindows` in windows of 32 steps, every river's discharge each step  | 524 ms      |
| `startWindows` in windows of 64 steps, every river's discharge each step  | 448 ms      |
| `startWindows` in windows of 256 steps, every river's discharge each step | 657 ms      |

The player's windows of 64 steps take 51 µs a step for every river of the Columbia, its discharge read out at every
step included. The first route on a page takes about 35 ms more, while each worker compiles the blosc decoder.
