# jsrr

The simplest case of river-route for the browser: Muskingum routing with static coefficients, the uniform runoff
transform, one reach per river routed at the runoff time step, and every river starting from no discharge. It matches
river-route to within 1e-6 of the peak discharge.

The page is a map of every stream, patterned after webapp-rfs-v3. Clicking a river picks the study area, that river and
every river upstream of it; the panel then routes it over the time period chosen, reading its inputs over HTTP, and the
player plays every river's discharge on the map a step at a time while the panel draws the outlet's hydrograph. The
reset button in the panel's header clears the study area and its route, keeping the period and the data sources.

| Input              | Format                                                                                         |
|--------------------|------------------------------------------------------------------------------------------------|
| Routing parameters | parquet with `river_id`, `next_river_id`, `k`, `x`, every river before the one it drains into  |
| Grid weights       | parquet with `river_id`, `x_index`, `y_index`, `area_sqm`, `proportion`, as in the netCDF      |
| Runoff             | (time, y, x) zarr arrays of runoff depths, v2 or v3, a year each, like `.../era5_1940.zarr/ro` |
| Streams            | PMTiles of the streams, with `riverId`, `riverIndex`, `upstreamCount`, and `TDXHydroRegion`    |

The data sources dialog, the cog in the panel's header, names each input by a url, in which `{region}` stands for the
study area's region and `{year}` for each year of the period. Each year's runoff array must go on from the step after
the last year's ends, on the same grid. Its time coordinate is the array named by its first dimension, beside it in the
store; its steps must be uniform, and its units attribute one river-route reads (m, mm, kg m-2), or absent for meters.
Only the chunks holding the cells of the routed catchments are read.

## Running

```bash
npm install
npm run dev        # the pages, with the test data at /data/, at the address vite prints, and /live.html
npm test           # starts its own server, routes the test data, and compares with river-route
npm run benchmark  # times each stage in both orders, in one thread and with pools of workers, and each kernel alone
```

Each of these first builds the routing kernel from C with `npm run wasm`, which needs Homebrew's `llvm@22` and `lld@22`
(or `LLVM_BIN` and `LLD_BIN` naming other folders of clang and wasm-ld).

The dev server serves `data/` at `/data/` as plain files, following links, which is how the inputs are read in place.
`tests/prepare_test_data.py` fills it, run from this folder with the python environment of river-route beside it:

```bash
../river-route/.venv/bin/python tests/prepare_test_data.py \
    --region-dir ~/data/v3TestData/hydrography/region=7020014250 \
    --runoff ~/data/era5_zarr_16x16_yearly/year=1940/era5_1940.zarr \
    --rivers 720184033 \
    --page-region-dirs ~/data/v3TestData/hydrography/region=* \
    --more-runoff ~/data/era5_zarr_16x16_yearly/year=194[1-9]/era5_194[1-9].zarr \
    --streams ~/data/v3TestData/hydrography/global/streams.pmtiles
```

It links the region's `routing.parquet` and the runoff store, writes the grid weights as parquet with
`grid_weights_to_parquet`, and routes the region with river-route to record the hydrographs of the main outlet and of
each river in `--rivers`, which the tests reproduce. The last three arguments serve the page: every region a click may
pick, linked and converted the same way, the runoff of the years after, which a test also reads, and the streams. The
dev server answers a request for a byte range of a file, as the PMTiles reader asks.

## How it routes

The page hands the inputs to a worker, which reads the two parquet files and the metadata of each year's runoff array at
once, keeps the rivers upstream of the target, and reads their cells' runoff over the period chunk by chunk on a pool of
workers. The pool then
routes regions of the network at once, subtrees of at most a few thousand rivers packed onto the workers largest first,
while the page's worker routes the main stem the regions drain into. Each river's whole series is routed before the
next, with its upstream inflow summed in a row of a pool that only a handful of rivers need at once.

`routeHydrograph` also routes time-step-first, every river for one step before the next, when its inputs say
`order: 'time'`; the page routes river-first, the default, and both give the same hydrograph.

The worker hands the page what it routed, the network and its runoff, and the page routes it again time-step-first in
its own thread, one step for each the player shows, with the stepper of `src/muskingum-wasm.js`, so that a period of any
length is never held as every river's discharge at every step. The kernel then classes every river's discharge, 5
classes to each tenfold from 0.1 m³/s or less up to 10⁵ m³/s or more: 0.13 ms a step for the Amazon's 237,718 rivers,
against 3.6 ms in JavaScript, and the step itself routes in 0.23 ms. Finer classes would differ by colors too close to
tell apart, and every class a river crosses costs the map an update: at 5 a tenfold, about 4% of rivers change class an
hour, against 7% at 8. The map draws classes as feature state, as webapp-rfs-v3 animates its forecasts, on only the
routed rivers the tiles in view hold, found again as tiles load and the view moves, and a step sets state only on a
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

The routing never stops. A worker, `src/live-worker.js`, routes every river of the regions loaded an hour at a time, as
many hours a second as the page asks, with the kernel's live stepping, whose runoff forcing its caller gives each step
rather than reading from runoff arrays. The page's messages, the pulses, the sources placed and erased, the regions to
load, and the rate, wait in a queue that each tick of the worker takes up first. Its answers are frames of every river's
discharge class after the latest step, and the page is only ever handed the newest: the next frame waits until the page
has drawn the last and handed its buffer back, so that frames never pile up behind a busy page. The panel shows the map
updates of the last second: how many there were, and the mean milliseconds of each stage of one, from taking up the
queue, routing, and classing discharge in the worker, to handing the frame to the page, drawing it as feature state, and
the map drawing it on the screen, and their sum.

A region loads the first time the brush passes over one of its rivers, and its rivers join the network after those of
the regions before, each keeping its discharge, so that routing goes on undisturbed. `src/live-engine.js` gives each
source's and pulse's runoff to the rivers whose catchments it covers, by the region's grid weights, and the map draws
only the rivers holding more than the lowest class of discharge, 0.1 m³/s, over the network. The reset in the header
erases every source, stops every pulse, and empties every river. The dialog's runoff grid and streams, when changed,
start the page over from an address naming every source.

## The kernel

`src/muskingum.c` routes, compiled to WebAssembly by `build-wasm.js`, and `src/muskingum-wasm.js` lays its arrays out
in the module's memory and calls it. `src/muskingum.js` is the same routing in JavaScript: the reference the tests hold
the C to, 7 times slower river-first and 12 times slower time-step-first.

The C computes in float32 with 128 bit vectors, four steps to a vector, as river-route computes in float32. Each river's
recurrence `q[t] = c3 q[t-1] + forcing[t]` is solved eight steps at a time by a prefix scan, so that only one vector
multiply and add per eight steps waits on the step before, which is river-route's numba kernel's trick in vector form.
A river reads its catchment's one or two cells' runoff as it routes, and headwaters take a loop without the inflow.

It is built twice: `muskingum-relaxed.wasm` uses WebAssembly's relaxed SIMD, whose fused multiply and add routed 20%
faster, and `muskingum.wasm` does not, for browsers without it. The page takes whichever the browser compiles.

Time-step-first routing carries one value per river from one step to the next, its discharge. The rivers are routed
in the order of their topological levels, headwaters first, so that no river drains into a river of its own level and
each level's rivers are routed four to a vector; in routing order, three rivers in four read what the river before had
just pushed into them, which chained the whole network into one sequence, 3.2 times slower. Each river pushes c1 times
its new discharge plus c2 times its old into the forcing of the river it drains into, which sums them over its
upstream rivers into c1 I[t] + c2 I[t-1]. The runoff forcing is summed ahead 32 steps at a time with vectors along
time, four rivers at a time, and turned into a row of every river for each step. It is three times slower than
river-first routing because each push is a write to a river elsewhere, one lane at a time, where river-first routing
adds whole series with vectors, and because it routes all 30,000 rivers' state through the cache every step.

River-first routing can also route window by window (`routeRiversByTimeWindow` in `src/muskingum-wasm.js`): every
river's series for a window of steps before the next window, each river carrying its discharge and inflow from one
window into the next, handing every river's discharge in each window to a callback. That gives every river's discharge
in time order, as time-step-first routing does, at the speed of river-first routing once windows are a few hundred
steps long.

The C follows NASA's rules for C: it allocates nothing, loops over counts it checks, checks every argument and returns
a code naming any problem, and builds only when clang-tidy, the clang static analyzer, and `-Weverything` find nothing.
`build-wasm.js` explains each of the few warnings it turns off. Routing is split into calls of a few hundred rivers,
since browsers swap in a function's optimized code only between calls: in one call, the first route in each worker ran
at a third of the speed.

## Speed

Routing the Columbia above its mouth, 29,876 rivers through the 8,777 hours of 1940, on an M3 Max, the average of two
routes after a first:

| where      | order           | inputs | runoff | routing | total  |
|------------|-----------------|--------|--------|---------|--------|
| one thread | river-first     | 44 ms  | 142 ms | 79 ms   | 264 ms |
| one thread | time-step-first | 41 ms  | 139 ms | 242 ms  | 422 ms |
| 8 workers  | river-first     | 37 ms  | 38 ms  | 28 ms   | 103 ms |
| 8 workers  | time-step-first | 44 ms  | 31 ms  | 74 ms   | 149 ms |

The kernels alone, in one thread:

| kernel                                                             | JavaScript | WebAssembly |
|--------------------------------------------------------------------|------------|-------------|
| river-first                                                        | 574 ms     | 79 ms       |
| time-step-first                                                    | 2,778 ms   | 238 ms      |
| time-step-first, handing every river's discharge after each step   |            | 338 ms      |
| windows of 32 steps, handing every river's discharge in each       |            | 155 ms      |
| windows of 256 steps, handing every river's discharge in each      |            | 88 ms       |

Time-step-first routing takes 27 µs per step for every river of the Columbia, and 39 µs handing every river's
discharge after each step. The first route on a page takes about 35 ms more, while each worker compiles the blosc
decoder.
