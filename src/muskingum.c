/*
 * The routing kernel of jsrr in C, compiled to WebAssembly by build-wasm.js: Muskingum routing with static
 * coefficients and the uniform runoff transform, one reach per river at the runoff step, every river starting from no
 * discharge. It routes the rivers of a network in order, each river's whole series before the next, as muskingum.js
 * does, and leaves the series of every outlet in rows the caller reads back.
 *
 * muskingum-wasm.js lays out every array in the module's memory before calling it, so nothing here allocates memory.
 * Every function checks its arguments and reports a problem as a negative code, which describe_problem names.
 *
 * Every series is float32, as in river-route, and padded with zeros to a whole number of blocks of eight steps. The
 * padding is routed like any other steps and ignored, since no step depends on a later one. Each inflow row starts
 * ROW_HEADER floats before its first step, and the last of them is the inflow before the first step: zero.
 *
 * build-wasm.js builds two modules from this file: muskingum-relaxed.wasm, whose multiply_add is the single fused
 * instruction of WebAssembly's relaxed SIMD, which routed the Columbia 20% faster, and muskingum.wasm, which multiplies
 * and then adds, for browsers without relaxed SIMD.
 */
#include <wasm_simd128.h>

enum {
    MAX_RIVERS = 16777216,  /* 2^24: the most rivers, cells, weights, and steps a network may have */
    MAX_CELLS = 16777216,
    MAX_WEIGHTS = 67108864, /* 2^26 */
    MAX_STEPS = 16777216,
    MAX_FLOATS = 1073741824, /* 2^30: the most floats in one array, 4 GB, all the memory a module can have */
    STEPS_PER_BLOCK = 8,  /* the steps routed per pass of the routing loop: two vectors of four */
    ROW_HEADER = 4,       /* the floats before an inflow row's first step, which keep its steps aligned */
};

enum {
    OK = 0,
    PROBLEM_SIZES = -1,
    PROBLEM_MISSING_ARRAY = -2,
    PROBLEM_DRAINS_UPSTREAM = -3,
    PROBLEM_NO_WEIGHTS = -4,
    PROBLEM_WEIGHT_CELL = -5,
    PROBLEM_INJECTION_ORDER = -6,
    PROBLEM_OUTLETS = -7,
    PROBLEM_TOO_FEW_ROWS = -8,
};

/* The arrays of a network in routing order, as start_routing is given them. */
struct network {
    int n_rivers;
    int n_padded; /* the steps of every series, padded */
    int n_injected;
    const int *downstream_positions;
    const float *c1;
    const float *c2;
    const float *c3;
    const int *weight_start;
    const int *weight_cell;
    const float *weight_forcing;
    const float *runoff;
    const int *injected_rivers;
    const float *injected_series;
};

/* The arrays routing writes: n_rows pool rows, then a row per outlet. */
struct work {
    int n_rows;
    int stride; /* the floats from one inflow row to the next */
    float *inflow_rows;
    int *row_of_river;
    int *free_rows;
    float *lateral;
};

/* How far routing has come. */
struct progress {
    int n_free_rows;
    int next_outlet_row;
    int next_injection;
};

/*
 * Everything routing needs, kept in the module's memory from one call to the next. Routing is split into calls of a
 * few hundred rivers because browsers swap a function's optimized code in only between calls: routed in one call, the
 * first route in each worker took nearly three times as long in V8, all of it in code compiled for a quick start.
 */
struct routing {
    struct network network;
    struct work work;
    struct progress progress;
    int n_outlets;
    int n_routed; /* the rivers routed so far, in order */
};

int padded_steps(int n_steps);
int row_stride(int n_steps);
const char *describe_problem(int problem);
int count_peak_inflow_rows(int n_rivers, const int *downstream_positions, int n_injected, const int *injected_rivers,
                           unsigned char *has_row);
int routing_size(void);
int start_routing(struct routing *routing, int n_rivers, int n_steps, int n_cells, int n_injected, int n_rows,
                  int n_outlets, const int *downstream_positions, const float *c1, const float *c2, const float *c3,
                  const int *weight_start, const int *weight_cell, const float *weight_forcing, const float *runoff,
                  const int *injected_rivers, const float *injected_series,
                  float *inflow_rows, int *row_of_river, int *free_rows, float *lateral);
int route_next_rivers(struct routing *routing, int n_rivers);

/* The steps every series is padded to: n_steps rounded up to a whole number of blocks, or 0 for a bad count. */
int padded_steps(int n_steps) {
    if (n_steps < 1 || n_steps > MAX_STEPS) {
        return 0;
    }
    return (n_steps + STEPS_PER_BLOCK - 1) / STEPS_PER_BLOCK * STEPS_PER_BLOCK;
}

/* The floats from one inflow row to the next, a header and the padded steps, or 0 for a bad count. */
int row_stride(int n_steps) {
    const int n_padded = padded_steps(n_steps);
    return n_padded == 0 ? 0 : ROW_HEADER + n_padded;
}

const char *describe_problem(int problem) {
    switch (problem) {
    case OK: return "no problem";
    case PROBLEM_SIZES: return "a count of rivers, cells, weights, steps, or rows is out of range";
    case PROBLEM_MISSING_ARRAY: return "an array was not given";
    case PROBLEM_DRAINS_UPSTREAM: return "a river drains into itself or into a river before it";
    case PROBLEM_NO_WEIGHTS: return "a river has no weights";
    case PROBLEM_WEIGHT_CELL: return "a weight reads a cell outside the runoff";
    case PROBLEM_INJECTION_ORDER: return "the injected rivers are not positions in increasing order";
    case PROBLEM_OUTLETS: return "the count of outlets is not the count of rivers draining out of the network";
    case PROBLEM_TOO_FEW_ROWS: return "the pool has fewer inflow rows than routing needs at once";
    default: return "an unknown problem";
    }
}

/* Every river drains into a river after it or out of the network (-1), and injections go to rivers in order. */
static int check_topology(int n_rivers, const int *downstream_positions, int n_injected, const int *injected_rivers) {
    if (n_rivers < 1 || n_rivers > MAX_RIVERS || n_injected < 0 || n_injected > MAX_RIVERS) {
        return PROBLEM_SIZES;
    }
    if (downstream_positions == 0 || (n_injected > 0 && injected_rivers == 0)) {
        return PROBLEM_MISSING_ARRAY;
    }
    for (int river = 0; river < n_rivers; river++) {
        const int downstream = downstream_positions[river];
        if (downstream != -1 && (downstream <= river || downstream >= n_rivers)) {
            return PROBLEM_DRAINS_UPSTREAM;
        }
    }
    for (int injection = 0; injection < n_injected; injection++) {
        const int previous = injection > 0 ? injected_rivers[injection - 1] : 0;
        if (injected_rivers[injection] < previous || injected_rivers[injection] >= n_rivers) {
            return PROBLEM_INJECTION_ORDER;
        }
    }
    return OK;
}

/*
 * The most inflow rows open at once when the rivers are routed in order, which sizes the pool, or a problem. A river's
 * row opens when a series is injected into it or its first upstream river is routed, and closes once it is routed.
 * has_row is n_rivers bytes of scratch.
 */
int count_peak_inflow_rows(int n_rivers, const int *downstream_positions, int n_injected, const int *injected_rivers,
                           unsigned char *has_row) {
    const int problem = check_topology(n_rivers, downstream_positions, n_injected, injected_rivers);
    if (problem != OK) {
        return problem;
    }
    if (has_row == 0) {
        return PROBLEM_MISSING_ARRAY;
    }
    for (int river = 0; river < n_rivers; river++) {
        has_row[river] = 0;
    }
    int open = 0;
    int peak = 0;
    int next_injection = 0;
    for (int river = 0; river < n_rivers; river++) {
        for (; next_injection < n_injected && injected_rivers[next_injection] == river; next_injection++) {
            open += has_row[river] == 0 ? 1 : 0;
            has_row[river] = 1;
        }
        const int downstream = downstream_positions[river];
        if (downstream >= 0 && has_row[downstream] == 0) {
            has_row[downstream] = 1;
            open++;
        }
        peak = open > peak ? open : peak;
        open -= has_row[river];
    }
    return peak;
}

/* Every array is given, and every river has weights that read cells of the runoff. */
static int check_network(struct network network, int n_cells) {
    if (network.c1 == 0 || network.c2 == 0 || network.c3 == 0 || network.weight_start == 0
        || network.weight_cell == 0 || network.weight_forcing == 0 || network.runoff == 0
        || (network.n_injected > 0 && network.injected_series == 0)) {
        return PROBLEM_MISSING_ARRAY;
    }
    if (network.weight_start[0] != 0 || network.weight_start[network.n_rivers] > MAX_WEIGHTS) {
        return PROBLEM_SIZES;
    }
    for (int river = 0; river < network.n_rivers; river++) {
        if (network.weight_start[river + 1] <= network.weight_start[river]) {
            return PROBLEM_NO_WEIGHTS;
        }
    }
    for (int weight = 0; weight < network.weight_start[network.n_rivers]; weight++) {
        if (network.weight_cell[weight] < 0 || network.weight_cell[weight] >= n_cells) {
            return PROBLEM_WEIGHT_CELL;
        }
    }
    return OK;
}

/* Every work array is given, and there is a row for every outlet: every river draining out of the network. */
static int check_work(struct network network, struct work work, int n_outlets) {
    if (work.inflow_rows == 0 || work.row_of_river == 0 || work.lateral == 0
        || (work.n_rows > 0 && work.free_rows == 0)) {
        return PROBLEM_MISSING_ARRAY;
    }
    int outlets = 0;
    for (int river = 0; river < network.n_rivers; river++) {
        outlets += network.downstream_positions[river] == -1 ? 1 : 0;
    }
    return outlets == n_outlets ? OK : PROBLEM_OUTLETS;
}

/* left * right + addend, in one fused instruction where the module is built with relaxed SIMD. */
static inline v128_t multiply_add(v128_t left, v128_t right, v128_t addend) {
#ifdef __wasm_relaxed_simd__
    return wasm_f32x4_relaxed_madd(left, right, addend);
#else
    return wasm_f32x4_add(wasm_f32x4_mul(left, right), addend);
#endif
}

/* The first step of an inflow row. */
static inline float *row_steps(struct work work, int row) {
    return work.inflow_rows + (row * work.stride) + ROW_HEADER;
}

/* The padded runoff series of a cell. */
static inline const float *cell_runoff(struct network network, int cell) {
    return network.runoff + (cell * network.n_padded);
}

/*
 * Write the runoff forcing of weights first_weight to stop_weight into lateral: the sum of each weight's multiplier
 * times its cell's runoff, which is c4 = (c1 + c2) / dt times the catchment runoff volume the cell adds in the step.
 */
static int sum_lateral_forcing(struct network network, int first_weight, int stop_weight, float *lateral) {
    if (stop_weight <= first_weight || network.n_padded % STEPS_PER_BLOCK != 0) {
        return PROBLEM_NO_WEIGHTS;
    }
    const float *first_runoff = cell_runoff(network, network.weight_cell[first_weight]);
    const v128_t first_forcing = wasm_f32x4_splat(network.weight_forcing[first_weight]);
    for (int step = 0; step < network.n_padded; step += 4) {
        wasm_v128_store(lateral + step, wasm_f32x4_mul(first_forcing, wasm_v128_load(first_runoff + step)));
    }
    for (int weight = first_weight + 1; weight < stop_weight; weight++) {
        const float *other_runoff = cell_runoff(network, network.weight_cell[weight]);
        const v128_t forcing = wasm_f32x4_splat(network.weight_forcing[weight]);
        for (int step = 0; step < network.n_padded; step += 4) {
            const v128_t runoff = wasm_v128_load(other_runoff + step);
            wasm_v128_store(lateral + step, multiply_add(forcing, runoff, wasm_v128_load(lateral + step)));
        }
    }
    return OK;
}

/* The coefficients of one river, each in every lane of a vector. */
struct lanes {
    v128_t c1;
    v128_t c2;
    v128_t c3;
    v128_t c3_squared;
    v128_t powers_1_to_4; /* c3, c3^2, c3^3, c3^4 */
    v128_t powers_5_to_8;
    v128_t first_forcing;  /* the multiplier of the first runoff row */
    v128_t second_forcing; /* the multiplier of the second */
};

/* The rows one river's routing reads and writes, each at its first step; second_runoff and inflow may be 0. */
struct rows {
    const float *first_runoff;
    const float *second_runoff;
    const float *inflow;
    float *outflow;
};

/*
 * The partial sums of q[t] = c3 q[t-1] + a[t] over four steps from q = 0: a0, a1 + c3 a0, a2 + c3 a1 + c3^2 a0, and so
 * on. Adding to each lane c3 times the lane before, then c3^2 times the sum two lanes before, is a prefix scan.
 */
static inline v128_t scan_four_steps(v128_t forcing, struct lanes lanes) {
    const v128_t zero = wasm_f32x4_splat(0.0F);
    const v128_t one_before = wasm_i32x4_shuffle(zero, forcing, 3, 4, 5, 6);
    const v128_t sums_of_two = multiply_add(lanes.c3, one_before, forcing);
    const v128_t two_before = wasm_i32x4_shuffle(zero, sums_of_two, 2, 3, 4, 5);
    return multiply_add(lanes.c3_squared, two_before, sums_of_two);
}

static inline v128_t last_lane_everywhere(v128_t lanes) {
    return wasm_i32x4_shuffle(lanes, lanes, 3, 3, 3, 3);
}

/*
 * The forcing of the four steps from step: the runoff's, from one row or two, and with_inflow, c1 times the inflow at
 * the end of each step and c2 times it at the start. with_second and with_inflow are constants wherever this is
 * inlined, so their tests cost nothing.
 */
static inline v128_t forcing_of_four_steps(struct lanes lanes, struct rows rows, int step, int with_second,
                                           int with_inflow) {
    v128_t forcing = wasm_f32x4_mul(lanes.first_forcing, wasm_v128_load(rows.first_runoff + step));
    if (with_second != 0) {
        forcing = multiply_add(lanes.second_forcing, wasm_v128_load(rows.second_runoff + step), forcing);
    }
    if (with_inflow != 0) {
        forcing = multiply_add(lanes.c2, wasm_v128_load(rows.inflow + step - 1), forcing);
        forcing = multiply_add(lanes.c1, wasm_v128_load(rows.inflow + step), forcing);
    }
    return forcing;
}

/*
 * Solve the recurrence q[t] = c3 q[t-1] + forcing[t] eight steps at a time and add each step's discharge into outflow:
 * each half of a block is scanned on its own, the second half is given the first's last sum, and the discharge before
 * the block reaches each step as c3^(i+1) times it. Only that last multiply and add waits on the block before, so the
 * serial chain is one vector multiply and add per eight steps.
 */
static inline void route_blocks(int n_padded, struct lanes lanes, struct rows rows, int with_second,
                                int with_inflow) {
    float *outflow = rows.outflow;
    v128_t before = wasm_f32x4_splat(0.0F); /* the discharge at the end of the block before, in every lane */
    for (int step = 0; step < n_padded; step += STEPS_PER_BLOCK) {
        const v128_t first_forcing = forcing_of_four_steps(lanes, rows, step, with_second, with_inflow);
        const v128_t second_forcing = forcing_of_four_steps(lanes, rows, step + 4, with_second, with_inflow);
        const v128_t first = scan_four_steps(first_forcing, lanes);
        const v128_t second_alone = scan_four_steps(second_forcing, lanes);
        const v128_t second = multiply_add(lanes.powers_1_to_4, last_lane_everywhere(first), second_alone);
        const v128_t discharge_first = multiply_add(lanes.powers_1_to_4, before, first);
        const v128_t discharge_second = multiply_add(lanes.powers_5_to_8, before, second);
        wasm_v128_store(outflow + step, wasm_f32x4_add(wasm_v128_load(outflow + step), discharge_first));
        wasm_v128_store(outflow + step + 4, wasm_f32x4_add(wasm_v128_load(outflow + step + 4), discharge_second));
        before = last_lane_everywhere(discharge_second);
    }
}

/*
 * Route one river's whole series and add it into its outflow row. Its runoff forcing is first_forcing times the first
 * runoff row, plus second_forcing times the second when there is one. inflow is its upstream rivers' summed discharge,
 * or 0 for a headwater, which has none. Each of the four combinations is routed by its own loop, without the loads and
 * multiplies of what the river lacks: the Columbia's rivers are split about evenly between one runoff row and two, and
 * a quarter of them are headwaters.
 */
static int route_river(int n_padded, const float *coefficients, float first_forcing, float second_forcing,
                       struct rows rows) {
    if (n_padded < STEPS_PER_BLOCK || n_padded % STEPS_PER_BLOCK != 0) {
        return PROBLEM_SIZES;
    }
    if (rows.inflow == rows.outflow || rows.first_runoff == 0 || rows.outflow == 0) {
        return PROBLEM_MISSING_ARRAY;
    }
    const float c3 = coefficients[2];
    const float c3_squared = c3 * c3;
    const float c3_fourth = c3_squared * c3_squared;
    const v128_t powers_1_to_4 = wasm_f32x4_make(c3, c3_squared, c3_squared * c3, c3_fourth);
    const struct lanes lanes = {
        wasm_f32x4_splat(coefficients[0]), wasm_f32x4_splat(coefficients[1]), wasm_f32x4_splat(c3),
        wasm_f32x4_splat(c3_squared), powers_1_to_4, wasm_f32x4_mul(powers_1_to_4, wasm_f32x4_splat(c3_fourth)),
        wasm_f32x4_splat(first_forcing), wasm_f32x4_splat(second_forcing),
    };
    if (rows.inflow == 0 && rows.second_runoff == 0) {
        route_blocks(n_padded, lanes, rows, 0, 0);
    } else if (rows.inflow == 0) {
        route_blocks(n_padded, lanes, rows, 1, 0);
    } else if (rows.second_runoff == 0) {
        route_blocks(n_padded, lanes, rows, 0, 1);
    } else {
        route_blocks(n_padded, lanes, rows, 1, 1);
    }
    return OK;
}

/* The row of a river's inflow, taken from the pool and zeroed, header and steps, if it has none yet; or a problem. */
static int take_row_if_needed(struct work work, struct progress *progress, int river) {
    if (work.row_of_river[river] >= 0) {
        return work.row_of_river[river];
    }
    if (progress->n_free_rows < 1) {
        return PROBLEM_TOO_FEW_ROWS;
    }
    progress->n_free_rows -= 1;
    const int row = work.free_rows[progress->n_free_rows];
    float *header = row_steps(work, row) - ROW_HEADER;
    for (int value = 0; value < work.stride; value++) {
        header[value] = 0.0F;
    }
    work.row_of_river[river] = row;
    return row;
}

/* Add a padded series routed elsewhere into a river's inflow row. */
static void add_series(int n_padded, const float *series, float *inflow) {
    for (int step = 0; step < n_padded; step += 4) {
        wasm_v128_store(inflow + step, wasm_f32x4_add(wasm_v128_load(inflow + step), wasm_v128_load(series + step)));
    }
}

/*
 * Route the next river in order: add the series injected into it to its inflow, take the row of the river it drains
 * into, or the next outlet row, route its series into that row, and give its own row back. A river reads the runoff of
 * its catchment's first cell and, if it has one, its second as it routes; the runoff of any others is summed into the
 * lateral row first, which is then read as the second.
 */
static int route_next_river(struct network network, struct work work, struct progress *progress, int river) {
    for (; progress->next_injection < network.n_injected
           && network.injected_rivers[progress->next_injection] == river;
         progress->next_injection++) {
        const int row = take_row_if_needed(work, progress, river);
        if (row < OK) {
            return row;
        }
        add_series(network.n_padded, network.injected_series + (progress->next_injection * network.n_padded),
                   row_steps(work, row));
    }
    const int downstream = network.downstream_positions[river];
    const int outflow_row = downstream >= 0 ? take_row_if_needed(work, progress, downstream)
                                            : progress->next_outlet_row++;
    if (outflow_row < OK) {
        return outflow_row;
    }
    const int first_weight = network.weight_start[river];
    const int n_weights = network.weight_start[river + 1] - first_weight;
    struct rows rows = {cell_runoff(network, network.weight_cell[first_weight]), 0,
                        work.row_of_river[river] >= 0 ? row_steps(work, work.row_of_river[river]) : 0,
                        row_steps(work, outflow_row)};
    float second_forcing = 0.0F;
    int problem = OK;
    if (n_weights == 2) {
        rows.second_runoff = cell_runoff(network, network.weight_cell[first_weight + 1]);
        second_forcing = network.weight_forcing[first_weight + 1];
    } else if (n_weights > 2) {
        problem = sum_lateral_forcing(network, first_weight + 1, first_weight + n_weights, work.lateral);
        rows.second_runoff = work.lateral;
        second_forcing = 1.0F;
    }
    const float coefficients[3] = {network.c1[river], network.c2[river], network.c3[river]};
    if (problem == OK) {
        problem = route_river(network.n_padded, coefficients, network.weight_forcing[first_weight], second_forcing,
                              rows);
    }
    if (work.row_of_river[river] >= 0) {
        work.free_rows[progress->n_free_rows] = work.row_of_river[river];
        progress->n_free_rows += 1;
    }
    return problem;
}

/* Every row free, no river holding one, and the outlets' rows zeroed. */
static void reset_work(struct work work, int n_rivers, int n_outlets) {
    for (int river = 0; river < n_rivers; river++) {
        work.row_of_river[river] = -1;
    }
    for (int row = 0; row < work.n_rows; row++) {
        work.free_rows[row] = row;
    }
    float *outlet_rows = row_steps(work, work.n_rows) - ROW_HEADER;
    for (int value = 0; value < n_outlets * work.stride; value++) {
        outlet_rows[value] = 0.0F;
    }
}

int routing_size(void) {
    return (int)sizeof(struct routing);
}

/*
 * Check a network and set routing up to route it: every river in order, leaving each outlet's series in the rows after
 * the pool's, in routing order. Returns OK or a problem. The caller lays out every array: inflow_rows holds
 * n_rows + n_outlets rows of row_stride(n_steps) floats, row_of_river n_rivers ints, free_rows n_rows ints, lateral one
 * padded series, and routing routing_size() bytes. n_rows is what count_peak_inflow_rows gives for the same rivers and
 * injections.
 */
int start_routing(struct routing *routing, int n_rivers, int n_steps, int n_cells, int n_injected, int n_rows,
                  int n_outlets, const int *downstream_positions, const float *c1, const float *c2, const float *c3,
                  const int *weight_start, const int *weight_cell, const float *weight_forcing, const float *runoff,
                  const int *injected_rivers, const float *injected_series,
                  float *inflow_rows, int *row_of_river, int *free_rows, float *lateral) {
    const long long n_padded = padded_steps(n_steps);
    const long long n_row_floats = ((long long)n_rows + n_outlets) * (ROW_HEADER + n_padded);
    if (n_padded == 0 || n_cells < 1 || n_cells > MAX_CELLS || n_rows < 0 || n_rows > n_rivers || n_outlets < 1
        || (long long)n_cells * n_padded > MAX_FLOATS || (long long)n_injected * n_padded > MAX_FLOATS
        || n_row_floats > MAX_FLOATS) {
        return PROBLEM_SIZES;
    }
    const struct network network = {n_rivers, (int)n_padded, n_injected, downstream_positions, c1, c2, c3,
                                     weight_start, weight_cell, weight_forcing, runoff, injected_rivers,
                                     injected_series};
    const struct work work = {n_rows, ROW_HEADER + (int)n_padded, inflow_rows, row_of_river, free_rows, lateral};
    int problem = routing == 0 ? PROBLEM_MISSING_ARRAY : OK;
    problem = problem == OK ? check_topology(n_rivers, downstream_positions, n_injected, injected_rivers) : problem;
    problem = problem == OK ? check_network(network, n_cells) : problem;
    problem = problem == OK ? check_work(network, work, n_outlets) : problem;
    if (problem != OK) {
        return problem;
    }
    reset_work(work, n_rivers, n_outlets);
    const struct progress progress = {n_rows, n_rows, 0}; /* the outlets' rows follow the pool's */
    const struct routing started = {network, work, progress, n_outlets, 0};
    *routing = started;
    return OK;
}

/* Route up to n_rivers more rivers in order, from where the last call stopped. Returns the rivers left or a problem. */
int route_next_rivers(struct routing *routing, int n_rivers) {
    if (routing == 0) {
        return PROBLEM_MISSING_ARRAY;
    }
    struct routing state = *routing;
    const int n_left = state.network.n_rivers - state.n_routed;
    if (n_rivers < 1 || n_left < 0 || state.n_routed < 0) {
        return PROBLEM_SIZES;
    }
    const int stop = state.n_routed + (n_rivers < n_left ? n_rivers : n_left);
    int problem = OK;
    for (int river = state.n_routed; river < stop && problem == OK; river++) {
        problem = route_next_river(state.network, state.work, &state.progress, river);
    }
    state.n_routed = stop;
    *routing = state;
    return problem == OK ? state.network.n_rivers - stop : problem;
}
