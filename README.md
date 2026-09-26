# jsrr

The simplest case of river-route for the browser: Muskingum routing with static coefficients, the uniform runoff
transform, one reach per river routed at the runoff time step, and every river starting from no discharge. The page
reads three inputs over HTTP and routes the hydrograph of the region's outlet, the one that drains the largest area,
from only the rivers upstream of it. It matches river-route to within 1e-6 of the peak discharge.

| Input              | Format                                                                                               |
|--------------------|------------------------------------------------------------------------------------------------------|
| Routing parameters | parquet with `river_id`, `next_river_id`, `k`, `x`, every river listed before the one it drains into |
| Grid weights       | parquet with `river_id`, `x_index`, `y_index`, `area_sqm`, `proportion`: a grid weights netCDF as parquet |
| Runoff             | a (time, y, x) zarr array of runoff depths, v2 or v3, such as `.../era5_1940.zarr/ro`                 |

The runoff's time coordinate is the array named by its first dimension, beside it in the store. Its steps must be
uniform, and its units attribute one river-route reads (m, mm, kg m-2), or absent for meters. Only the chunks holding
the cells of the routed catchments are read.

## Running

```bash
npm install
npm run dev        # the page, with the test data at /data/, at the address vite prints
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
    --rivers 720184033
```

It links the region's `routing.parquet` and the runoff store, writes the grid weights as parquet with
`grid_weights_to_parquet`, and routes the region with river-route to record the hydrographs of the main outlet and of
each river in `--rivers`, which the tests reproduce.

## How it routes

The page hands the inputs to a worker, which reads the two parquet files and the runoff array's metadata at once, keeps
the rivers upstream of the target, and reads their cells' runoff chunk by chunk on a pool of workers. The pool then
routes regions of the network at once, subtrees of at most a few thousand rivers packed onto the workers largest first,
while the page's worker routes the main stem the regions drain into. Each river's whole series is routed before the
next, with its upstream inflow summed in a row of a pool that only a handful of rivers need at once.

`routeHydrograph` also routes time-step-first, every river for one step before the next, as a map drawing each step
would, when its inputs say `order: 'time'`; the page routes river-first, the default, and both give the same
hydrograph.

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
