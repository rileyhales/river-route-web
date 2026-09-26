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
npm run benchmark  # times each stage in one thread and with pools of workers, and each kernel alone
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

## The kernel

`src/muskingum.c` routes, compiled to WebAssembly by `build-wasm.js`, and `src/muskingum-wasm.js` lays its arrays out
in the module's memory and calls it. `src/muskingum.js` is the same routing in JavaScript: the reference the tests hold
the C to, and 7 times slower.

The C computes in float32 with 128 bit vectors, four steps to a vector, as river-route computes in float32. Each river's
recurrence `q[t] = c3 q[t-1] + forcing[t]` is solved eight steps at a time by a prefix scan, so that only one vector
multiply and add per eight steps waits on the step before, which is river-route's numba kernel's trick in vector form.
A river reads its catchment's one or two cells' runoff as it routes, and headwaters take a loop without the inflow.

It is built twice: `muskingum-relaxed.wasm` uses WebAssembly's relaxed SIMD, whose fused multiply and add routed 20%
faster, and `muskingum.wasm` does not, for browsers without it. The page takes whichever the browser compiles.

The C follows NASA's rules for C: it allocates nothing, loops over counts it checks, checks every argument and returns
a code naming any problem, and builds only when clang-tidy, the clang static analyzer, and `-Weverything` find nothing.
`build-wasm.js` explains each of the few warnings it turns off. Routing is split into calls of a few hundred rivers,
since browsers swap in a function's optimized code only between calls: in one call, the first route in each worker ran
at a third of the speed.

## Speed

Routing the Columbia above its mouth, 29,876 rivers through the 8,777 hours of 1940, on an M3 Max:

| where                   | inputs | runoff | routing | total  |
|-------------------------|--------|--------|---------|--------|
| one thread, JavaScript  | 43 ms  | 142 ms | 558 ms  | 742 ms |
| 8 workers, JavaScript   | 46 ms  | 53 ms  | 105 ms  | 204 ms |
| one thread, WebAssembly | 40 ms  | 142 ms | 80 ms   | 262 ms |
| 8 workers, WebAssembly  | 39 ms  | 53 ms  | 30 ms   | 122 ms |

The kernel alone routes the Columbia in 80 ms, against 569 ms in JavaScript. The first route on a page takes about
35 ms more, while each worker compiles the blosc decoder.
