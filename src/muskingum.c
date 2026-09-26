/*
 * The routing kernels of jsrr in C, compiled to WebAssembly by build-wasm.js: Muskingum routing with static
 * coefficients and the uniform runoff transform, one reach per river at the runoff step, every river starting from no
 * discharge. As muskingum.js does, it routes the rivers of a network in either order, leaving every outlet's series
 * for the caller to read back: each river's whole series before the next (start_routing and route_next_rivers), or a
 * window of it, window by window (next_window), or every river for one time step before the next (start_stepping and
 * route_next_steps), or, live, one step at a time with the runoff forcing the caller gives each step
 * (start_live_stepping and route_live_step).
 *
 * muskingum-wasm.js lays out every array in the module's memory before calling it, so nothing here allocates memory.
 * Every function checks its arguments and reports a problem as a negative code, which describe_problem names.
 *
 * Every series is float32, as in river-route, and padded with zeros to a whole number of 32 steps. The padding is
 * routed like any other steps and ignored, since no step depends on a later one. Each inflow row starts ROW_HEADER
 * floats before its first step, and the last of them is the inflow before the first step: zero, or in windows, the
 * inflow at the end of the window before.
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
    STEPS_PER_LATERAL_BLOCK = 32, /* the steps whose runoff forcing time-step-first routing sums at once */
    ROW_HEADER = 4,       /* the floats before an inflow row's first step, which keep its steps aligned */
    FLOAT_MANTISSA_BITS = 23, /* a float's bits: 23 of mantissa below 8 of exponent, biased by 127 */
    FLOAT_EXPONENT_BIAS = 127,
    FLOAT_MANTISSA = 8388607, /* the bits of a float's mantissa, 2^23 - 1 */
    FLOAT_ONE = 1065353216,   /* the bits of 1.0F: a float from 1 up to 2 has these exponent bits */
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
    PROBLEM_STEPS_DONE = -9,
    PROBLEM_LEVELS = -10,
    PROBLEM_WINDOW = -11,
    PROBLEM_WINDOW_UNFINISHED = -12,
    PROBLEM_CLASSES = -13,
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

/*
 * The arrays routing writes: n_rows pool rows, then a row per outlet, each as long as a window of steps. The rivers are
 * routed for every step at once, one window, or window by window, each river carrying its discharge and its inflow at
 * the end of one window into the next, with its discharge in each window kept for the caller.
 */
struct work {
    int n_rows;
    int stride;               /* the floats from one inflow row to the next: ROW_HEADER and a window's steps */
    int n_window;             /* the steps each river is routed for at once */
    int first_step;           /* the first step of the window being routed */
    float *inflow_rows;
    int *row_of_river;
    int *free_rows;
    float *lateral;
    float *carried_discharge; /* each river's discharge at the end of the window before, or 0 to start from none */
    float *carried_inflow;    /* each river's inflow at the end of the window before, or 0 to start from none */
    float *window_discharge;  /* each river's discharge in the window, a row of n_window each, or 0 to keep none */
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

/*
 * Everything time-step-first routing needs, kept in the module's memory from one call to the next. The rivers come in
 * the order of their topological levels, and no river drains into a river of its own level, so each level's rivers are
 * routed four to a vector. The runoff forcing of every river is summed ahead for STEPS_PER_LATERAL_BLOCK steps, with
 * vectors along time, then turned into a row of every river for each step. Only one value per river is carried from
 * one step to the next, its discharge, which copy_in_routing_order gives the caller between calls.
 */
struct stepping {
    struct network network;
    int n_steps;          /* the steps of the runoff, unpadded */
    int n_levels;
    int n_lanes;          /* n_rivers rounded up to a whole number of vectors, the length of a row of lateral_steps */
    int n_outlets;
    int n_routed;         /* the steps routed so far */
    const int *level_starts; /* n_levels + 1: the first river of each level, then n_rivers */
    float *discharge;     /* each river's discharge at the end of the last step routed */
    float *outlet_series; /* n_outlets rows of n_steps: each outlet's discharge */
    int *push_targets;    /* the river each river pushes into: the one it drains into, or itself for an outlet */
    int *outlets;         /* the position of each outlet, in order */
    float *push_c1;       /* the c1 each river pushes its discharge with: its downstream river's, or 0 for an outlet */
    float *push_c2;       /* and the c2 */
    float *lateral_rows;  /* four rivers' runoff forcing for the steps of the block, a row of STEPS_PER_LATERAL_BLOCK */
    float *lateral_steps; /* the same forcing as a row of n_lanes rivers for each step of the block, into which the
                             upstream rivers push as the step is routed */
};

int padded_steps(int n_steps);
int row_stride(int n_window);
const char *describe_problem(int problem);
int count_peak_inflow_rows(int n_rivers, const int *downstream_positions, int n_injected, const int *injected_rivers,
                           unsigned char *has_row);
int routing_size(void);
int start_routing(struct routing *routing, int n_rivers, int n_steps, int n_window, int n_cells, int n_injected,
                  int n_rows, int n_outlets, const int *downstream_positions, const float *c1, const float *c2,
                  const float *c3, const int *weight_start, const int *weight_cell, const float *weight_forcing,
                  const float *runoff, const int *injected_rivers, const float *injected_series, float *inflow_rows,
                  int *row_of_river, int *free_rows, float *lateral, float *carried_discharge, float *carried_inflow,
                  float *window_discharge);
int route_next_rivers(struct routing *routing, int n_rivers);
int next_window(struct routing *routing);
int stepping_size(void);
int stepping_scratch_floats(int n_rivers);
int stepping_scratch_ints(int n_rivers, int n_outlets);
int start_stepping(struct stepping *stepping, int n_rivers, int n_levels, int n_steps, int n_cells, int n_injected,
                   int n_outlets, const int *level_starts, const int *downstream_positions, const float *c1,
                   const float *c2, const float *c3, const int *weight_start, const int *weight_cell,
                   const float *weight_forcing, const float *runoff, const int *injected_rivers,
                   const float *injected_series, float *discharge, float *outlet_series, float *scratch_floats,
                   int *scratch_ints);
int route_next_steps(struct stepping *stepping, int n_steps);
int copy_in_routing_order(const struct stepping *stepping, const int *level_positions, float *discharge);
int classify_in_routing_order(const struct stepping *stepping, const int *level_positions, float lowest,
                              float classes_per_tenfold, float top_class, float *class_values);
int live_scratch_floats(int n_rivers);
int start_live_stepping(struct stepping *stepping, int n_rivers, int n_levels, int n_outlets, const int *level_starts,
                        const int *downstream_positions, const float *c1, const float *c2, const float *c3,
                        float *discharge, float *scratch_floats, int *scratch_ints);
int route_live_step(struct stepping *stepping, float *forcing);
int set_discharge_in_routing_order(struct stepping *stepping, const int *level_positions, const float *discharge);

/*
 * The steps every series is padded to: n_steps rounded up to a whole number of the blocks time-step-first routing sums
 * runoff forcing in, which are a whole number of the blocks river-first routing routes; or 0 for a bad count.
 */
int padded_steps(int n_steps) {
    if (n_steps < 1 || n_steps > MAX_STEPS) {
        return 0;
    }
    return (n_steps + STEPS_PER_LATERAL_BLOCK - 1) / STEPS_PER_LATERAL_BLOCK * STEPS_PER_LATERAL_BLOCK;
}

/* The floats from one inflow row to the next for a window of n_window steps, a header and the steps, or 0 for a bad
 * count: a window is a whole number of blocks. */
int row_stride(int n_window) {
    if (n_window < STEPS_PER_BLOCK || n_window > MAX_STEPS || n_window % STEPS_PER_BLOCK != 0) {
        return 0;
    }
    return ROW_HEADER + n_window;
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
    case PROBLEM_STEPS_DONE: return "every step has been routed already";
    case PROBLEM_LEVELS: return "the levels do not cover the rivers in order, or a river drains into its own level";
    case PROBLEM_WINDOW: return "a window is not a whole number of blocks of 8 steps";
    case PROBLEM_WINDOW_UNFINISHED: return "a window has rivers left to route";
    case PROBLEM_CLASSES: return "discharge classes need a lowest discharge, classes a tenfold, and a top class above 0";
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
 * Write the runoff forcing of weights first_weight to stop_weight for the n_steps steps from first_step into lateral:
 * the sum of each weight's multiplier times its cell's runoff, which is c4 = (c1 + c2) / dt times the catchment runoff
 * volume the cell adds in the step.
 */
static int sum_lateral_forcing(struct network network, int first_weight, int stop_weight, int first_step, int n_steps,
                               float *lateral) {
    if (stop_weight <= first_weight || first_step < 0 || n_steps < 4 || n_steps % 4 != 0
        || first_step + n_steps > network.n_padded) {
        return PROBLEM_SIZES;
    }
    const float *first_runoff = cell_runoff(network, network.weight_cell[first_weight]) + first_step;
    const v128_t first_forcing = wasm_f32x4_splat(network.weight_forcing[first_weight]);
    for (int step = 0; step < n_steps; step += 4) {
        wasm_v128_store(lateral + step, wasm_f32x4_mul(first_forcing, wasm_v128_load(first_runoff + step)));
    }
    for (int weight = first_weight + 1; weight < stop_weight; weight++) {
        const float *other_runoff = cell_runoff(network, network.weight_cell[weight]) + first_step;
        const v128_t forcing = wasm_f32x4_splat(network.weight_forcing[weight]);
        for (int step = 0; step < n_steps; step += 4) {
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

/*
 * The rows one river's routing reads and writes, each at its first step: second_runoff and inflow may be 0, and
 * recorded, where the river's own discharge is kept, is 0 unless the caller keeps every river's.
 */
struct rows {
    const float *first_runoff;
    const float *second_runoff;
    const float *inflow;
    float *outflow;
    float *recorded;
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
 * Solve the recurrence q[t] = c3 q[t-1] + forcing[t] eight steps at a time from q = initial, add each step's
 * discharge into outflow, and return the last. Each half of a block is scanned on its own, the second half is given
 * the first's last sum, and the discharge before the block reaches each step as c3^(i+1) times it. Only that last
 * multiply and add waits on the block before, so the serial chain is one vector multiply and add per eight steps.
 */
static inline float route_blocks(int n_steps, struct lanes lanes, struct rows rows, float initial, int with_second,
                                 int with_inflow) {
    float *outflow = rows.outflow;
    v128_t before = wasm_f32x4_splat(initial); /* the discharge at the end of the block before, in every lane */
    for (int step = 0; step < n_steps; step += STEPS_PER_BLOCK) {
        const v128_t first_forcing = forcing_of_four_steps(lanes, rows, step, with_second, with_inflow);
        const v128_t second_forcing = forcing_of_four_steps(lanes, rows, step + 4, with_second, with_inflow);
        const v128_t first = scan_four_steps(first_forcing, lanes);
        const v128_t second_alone = scan_four_steps(second_forcing, lanes);
        const v128_t second = multiply_add(lanes.powers_1_to_4, last_lane_everywhere(first), second_alone);
        const v128_t discharge_first = multiply_add(lanes.powers_1_to_4, before, first);
        const v128_t discharge_second = multiply_add(lanes.powers_5_to_8, before, second);
        wasm_v128_store(outflow + step, wasm_f32x4_add(wasm_v128_load(outflow + step), discharge_first));
        wasm_v128_store(outflow + step + 4, wasm_f32x4_add(wasm_v128_load(outflow + step + 4), discharge_second));
        if (rows.recorded != 0) {
            wasm_v128_store(rows.recorded + step, discharge_first);
            wasm_v128_store(rows.recorded + step + 4, discharge_second);
        }
        before = last_lane_everywhere(discharge_second);
    }
    return wasm_f32x4_extract_lane(before, 0);
}

/*
 * Route one river for n_steps steps and add its discharge into its outflow row. Its runoff forcing is first_forcing
 * times the first runoff row, plus second_forcing times the second when there is one. inflow is its upstream rivers'
 * summed discharge, or 0 for a headwater, which has none. carried, when given, is the river's discharge before the
 * first step, replaced by its discharge after the last. Each of the four combinations is routed by its own loop,
 * without the loads and multiplies of what the river lacks: the Columbia's rivers are split about evenly between one
 * runoff row and two, and a quarter of them are headwaters.
 */
static int route_river(int n_steps, const float *coefficients, float first_forcing, float second_forcing,
                       struct rows rows, float *carried) {
    if (n_steps < STEPS_PER_BLOCK || n_steps % STEPS_PER_BLOCK != 0) {
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
    const float initial = carried != 0 ? *carried : 0.0F;
    float last = 0.0F;
    if (rows.inflow == 0 && rows.second_runoff == 0) {
        last = route_blocks(n_steps, lanes, rows, initial, 0, 0);
    } else if (rows.inflow == 0) {
        last = route_blocks(n_steps, lanes, rows, initial, 1, 0);
    } else if (rows.second_runoff == 0) {
        last = route_blocks(n_steps, lanes, rows, initial, 0, 1);
    } else {
        last = route_blocks(n_steps, lanes, rows, initial, 1, 1);
    }
    if (carried != 0) {
        *carried = last;
    }
    return OK;
}

/*
 * The row of a river's inflow, taken from the pool if it has none yet, or a problem. A row is taken zeroed, but for the
 * last float of its header, the inflow before the window's first step, which is the river's carried inflow.
 */
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
    header[ROW_HEADER - 1] = work.carried_inflow != 0 ? work.carried_inflow[river] : 0.0F;
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
    const int n_left = network.n_padded - work.first_step;
    const int n_steps = work.n_window < n_left ? work.n_window : n_left; /* the last window may be shorter */
    for (; progress->next_injection < network.n_injected
           && network.injected_rivers[progress->next_injection] == river;
         progress->next_injection++) {
        const int row = take_row_if_needed(work, progress, river);
        if (row < OK) {
            return row;
        }
        const float *series = network.injected_series + (progress->next_injection * network.n_padded);
        add_series(n_steps, series + work.first_step, row_steps(work, row));
    }
    const int downstream = network.downstream_positions[river];
    const int outflow_row = downstream >= 0 ? take_row_if_needed(work, progress, downstream)
                                            : progress->next_outlet_row++;
    if (outflow_row < OK) {
        return outflow_row;
    }
    const int first_weight = network.weight_start[river];
    const int n_weights = network.weight_start[river + 1] - first_weight;
    struct rows rows = {cell_runoff(network, network.weight_cell[first_weight]) + work.first_step, 0,
                        work.row_of_river[river] >= 0 ? row_steps(work, work.row_of_river[river]) : 0,
                        row_steps(work, outflow_row),
                        work.window_discharge != 0 ? work.window_discharge + (river * work.n_window) : 0};
    float second_forcing = 0.0F;
    int problem = OK;
    if (n_weights == 2) {
        rows.second_runoff = cell_runoff(network, network.weight_cell[first_weight + 1]) + work.first_step;
        second_forcing = network.weight_forcing[first_weight + 1];
    } else if (n_weights > 2) {
        problem = sum_lateral_forcing(network, first_weight + 1, first_weight + n_weights, work.first_step, n_steps,
                                      work.lateral);
        rows.second_runoff = work.lateral;
        second_forcing = 1.0F;
    }
    const float coefficients[3] = {network.c1[river], network.c2[river], network.c3[river]};
    if (problem == OK) {
        problem = route_river(n_steps, coefficients, network.weight_forcing[first_weight], second_forcing, rows,
                              work.carried_discharge != 0 ? work.carried_discharge + river : 0);
    }
    if (work.carried_inflow != 0) {
        work.carried_inflow[river] = rows.inflow != 0 ? rows.inflow[n_steps - 1] : 0.0F;
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
 * Check a network and set routing up to route it: every river in order, for all n_steps at once when n_window is at
 * least padded_steps(n_steps), or window by window of n_window steps, the last window as many as are left, leaving each
 * outlet's series for the window in the rows after the pool's, in routing order. Returns OK or a problem. The caller lays out every array: inflow_rows holds
 * n_rows + n_outlets rows of row_stride(n_window) floats, row_of_river n_rivers ints, free_rows n_rows ints, lateral
 * n_window floats, and routing routing_size() bytes; in windows, carried_discharge and carried_inflow n_rivers floats,
 * and window_discharge, if every river's discharge is kept, n_rivers rows of n_window. n_rows is what
 * count_peak_inflow_rows gives for the same rivers and injections.
 */
int start_routing(struct routing *routing, int n_rivers, int n_steps, int n_window, int n_cells, int n_injected,
                  int n_rows, int n_outlets, const int *downstream_positions, const float *c1, const float *c2,
                  const float *c3, const int *weight_start, const int *weight_cell, const float *weight_forcing,
                  const float *runoff, const int *injected_rivers, const float *injected_series, float *inflow_rows,
                  int *row_of_river, int *free_rows, float *lateral, float *carried_discharge, float *carried_inflow,
                  float *window_discharge) {
    const long long n_padded = padded_steps(n_steps);
    const long long n_row_floats = ((long long)n_rows + n_outlets) * row_stride(n_window);
    if (n_padded == 0 || n_cells < 1 || n_cells > MAX_CELLS || n_rows < 0 || n_rows > n_rivers || n_outlets < 1
        || (long long)n_cells * n_padded > MAX_FLOATS || (long long)n_injected * n_padded > MAX_FLOATS
        || n_row_floats > MAX_FLOATS || (window_discharge != 0 && (long long)n_rivers * n_window > MAX_FLOATS)) {
        return PROBLEM_SIZES;
    }
    if (row_stride(n_window) == 0) {
        return PROBLEM_WINDOW;
    }
    const struct network network = {n_rivers, (int)n_padded, n_injected, downstream_positions, c1, c2, c3,
                                     weight_start, weight_cell, weight_forcing, runoff, injected_rivers,
                                     injected_series};
    const struct work work = {n_rows, row_stride(n_window), n_window, 0, inflow_rows, row_of_river, free_rows, lateral,
                              carried_discharge, carried_inflow, window_discharge};
    const int missing_carries = n_window < n_padded && (carried_discharge == 0 || carried_inflow == 0);
    int problem = routing == 0 || missing_carries ? PROBLEM_MISSING_ARRAY : OK;
    problem = problem == OK ? check_topology(n_rivers, downstream_positions, n_injected, injected_rivers) : problem;
    problem = problem == OK ? check_network(network, n_cells) : problem;
    problem = problem == OK ? check_work(network, work, n_outlets) : problem;
    if (problem != OK) {
        return problem;
    }
    for (int river = 0; river < n_rivers && carried_discharge != 0 && carried_inflow != 0; river++) {
        carried_discharge[river] = 0.0F;
        carried_inflow[river] = 0.0F;
    }
    reset_work(work, n_rivers, n_outlets);
    const struct progress progress = {n_rows, n_rows, 0}; /* the outlets' rows follow the pool's */
    const struct routing started = {network, work, progress, n_outlets, 0};
    *routing = started;
    return OK;
}

/*
 * Move routing on to the next window, once every river of this one has been routed: its steps, a fresh pool, and
 * zeroed outlet rows, with each river's carried discharge and inflow. Returns the steps left, or a problem.
 */
int next_window(struct routing *routing) {
    if (routing == 0) {
        return PROBLEM_MISSING_ARRAY;
    }
    struct routing state = *routing;
    if (state.n_routed != state.network.n_rivers) {
        return PROBLEM_WINDOW_UNFINISHED;
    }
    const int first_step = state.work.first_step + state.work.n_window;
    if (first_step >= state.network.n_padded) {
        return PROBLEM_STEPS_DONE;
    }
    if (state.work.carried_discharge == 0 || state.work.carried_inflow == 0) {
        return PROBLEM_MISSING_ARRAY;
    }
    state.work.first_step = first_step;
    reset_work(state.work, state.network.n_rivers, state.n_outlets);
    const struct progress progress = {state.work.n_rows, state.work.n_rows, 0};
    state.progress = progress;
    state.n_routed = 0;
    *routing = state;
    return state.network.n_padded - first_step;
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

int stepping_size(void) {
    return (int)sizeof(struct stepping);
}

/* The rivers rounded up to a whole number of vectors of four, or 0 for a bad count. */
static int vector_lanes(int n_rivers) {
    if (n_rivers < 1 || n_rivers > MAX_RIVERS) {
        return 0;
    }
    return (n_rivers + 3) / 4 * 4;
}

/* The floats of scratch start_stepping needs for n_rivers rivers, or 0 for a bad count. */
int stepping_scratch_floats(int n_rivers) {
    return (vector_lanes(n_rivers) * (2 + STEPS_PER_LATERAL_BLOCK)) + (4 * STEPS_PER_LATERAL_BLOCK);
}

/* The ints of scratch start_stepping needs for n_rivers rivers and n_outlets outlets, or 0 for bad counts. */
int stepping_scratch_ints(int n_rivers, int n_outlets) {
    if (n_outlets < 1 || n_outlets > n_rivers) {
        return 0;
    }
    return vector_lanes(n_rivers) + n_outlets;
}

/* The levels cover the rivers in order, none empty, and every river drains out of the network or into a later level. */
static int check_levels(int n_rivers, int n_levels, const int *level_starts, const int *downstream_positions) {
    if (n_levels < 1 || n_levels > n_rivers || level_starts == 0) {
        return level_starts == 0 ? PROBLEM_MISSING_ARRAY : PROBLEM_LEVELS;
    }
    if (level_starts[0] != 0 || level_starts[n_levels] != n_rivers) {
        return PROBLEM_LEVELS;
    }
    for (int level = 0; level < n_levels; level++) {
        const int stop = level_starts[level + 1];
        if (stop <= level_starts[level]) {
            return PROBLEM_LEVELS;
        }
        for (int river = level_starts[level]; river < stop; river++) {
            if (downstream_positions[river] != -1 && downstream_positions[river] < stop) {
                return PROBLEM_LEVELS;
            }
        }
    }
    return OK;
}

/*
 * Carve the pushes out of the scratch, 2 n_lanes floats and stepping_scratch_ints ints, and set each river's push: into
 * the river it drains into, with that river's c1 and c2, or, for an outlet, nothing into itself. Returns the outlets
 * found.
 */
static int set_up_pushes(struct stepping *stepping, float *scratch_floats, int *scratch_ints) {
    const int n_lanes = stepping->n_lanes;
    stepping->push_targets = scratch_ints;
    stepping->outlets = scratch_ints + n_lanes;
    stepping->push_c1 = scratch_floats;
    stepping->push_c2 = scratch_floats + n_lanes;
    const struct network network = stepping->network;
    int n_found = 0;
    for (int river = 0; river < n_lanes; river++) {
        const int downstream = river < network.n_rivers ? network.downstream_positions[river] : -1;
        scratch_ints[river] = downstream >= 0 ? downstream : river;
        stepping->push_c1[river] = downstream >= 0 ? network.c1[downstream] : 0.0F;
        stepping->push_c2[river] = downstream >= 0 ? network.c2[downstream] : 0.0F;
        if (river < network.n_rivers && downstream < 0 && n_found < stepping->n_outlets) {
            stepping->outlets[n_found] = river;
        }
        n_found += river < network.n_rivers && downstream < 0 ? 1 : 0;
    }
    return n_found;
}

/*
 * Check a network, whose rivers come in the order of their topological levels, and set routing up to route it every
 * river for one time step before the next. Returns OK or a problem. The caller lays out every array: discharge holds
 * n_rivers floats, outlet_series n_outlets rows of n_steps, scratch_floats stepping_scratch_floats(n_rivers) floats,
 * scratch_ints stepping_scratch_ints(n_rivers, n_outlets) ints, and stepping stepping_size() bytes.
 */
int start_stepping(struct stepping *stepping, int n_rivers, int n_levels, int n_steps, int n_cells, int n_injected,
                   int n_outlets, const int *level_starts, const int *downstream_positions, const float *c1,
                   const float *c2, const float *c3, const int *weight_start, const int *weight_cell,
                   const float *weight_forcing, const float *runoff, const int *injected_rivers,
                   const float *injected_series, float *discharge, float *outlet_series, float *scratch_floats,
                   int *scratch_ints) {
    const long long n_padded = padded_steps(n_steps);
    if (n_padded == 0 || n_cells < 1 || n_cells > MAX_CELLS || stepping_scratch_ints(n_rivers, n_outlets) == 0
        || (long long)n_cells * n_padded > MAX_FLOATS || (long long)n_injected * n_padded > MAX_FLOATS
        || (long long)n_outlets * n_steps > MAX_FLOATS) {
        return PROBLEM_SIZES;
    }
    const struct network network = {n_rivers, (int)n_padded, n_injected, downstream_positions, c1, c2, c3,
                                     weight_start, weight_cell, weight_forcing, runoff, injected_rivers,
                                     injected_series};
    int problem = stepping == 0 || discharge == 0 || outlet_series == 0 || scratch_floats == 0 || scratch_ints == 0
                      ? PROBLEM_MISSING_ARRAY : OK;
    problem = problem == OK ? check_topology(n_rivers, downstream_positions, n_injected, injected_rivers) : problem;
    problem = problem == OK ? check_network(network, n_cells) : problem;
    problem = problem == OK ? check_levels(n_rivers, n_levels, level_starts, downstream_positions) : problem;
    if (problem != OK) {
        return problem;
    }
    const int n_lanes = vector_lanes(n_rivers);
    float *lateral_steps = scratch_floats + (2 * n_lanes); /* after the pushes */
    for (int value = 2 * n_lanes; value < stepping_scratch_floats(n_rivers); value++) {
        scratch_floats[value] = 0.0F;
    }
    const struct stepping started = {network, n_steps, n_levels, n_lanes, n_outlets, 0, level_starts, discharge,
                                     outlet_series, 0, 0, 0, 0,
                                     lateral_steps + (STEPS_PER_LATERAL_BLOCK * n_lanes), lateral_steps};
    *stepping = started;
    for (int river = 0; river < n_rivers; river++) {
        discharge[river] = 0.0F;
    }
    return set_up_pushes(stepping, scratch_floats, scratch_ints) == n_outlets ? OK : PROBLEM_OUTLETS;
}

/*
 * Sum the runoff forcing of four rivers from river for the STEPS_PER_LATERAL_BLOCK steps from first_step into their
 * rows of lateral_rows, with vectors along time as river-first routing does, then turn the rows into the four rivers'
 * lanes of each step's row of lateral_steps, four steps at a time, so that each step reads its forcing in order rather
 * than gathering it. A lane past the last river is given zeros. Returns OK or a problem.
 */
static int sum_lateral_of_four_rivers(struct stepping stepping, int first_step, int river) {
    const struct network network = stepping.network;
    for (int lane = 0; lane < 4; lane++) {
        float *row = stepping.lateral_rows + (lane * STEPS_PER_LATERAL_BLOCK);
        const int problem = river + lane < network.n_rivers
                                ? sum_lateral_forcing(network, network.weight_start[river + lane],
                                                      network.weight_start[river + lane + 1], first_step,
                                                      STEPS_PER_LATERAL_BLOCK, row)
                                : OK;
        if (problem != OK) {
            return problem;
        }
        for (int step = 0; step < STEPS_PER_LATERAL_BLOCK && river + lane >= network.n_rivers; step++) {
            row[step] = 0.0F;
        }
    }
    for (int quarter = 0; quarter < STEPS_PER_LATERAL_BLOCK; quarter += 4) {
        const float *rows = stepping.lateral_rows + quarter;
        const v128_t first = wasm_v128_load(rows);
        const v128_t second = wasm_v128_load(rows + STEPS_PER_LATERAL_BLOCK);
        const v128_t third = wasm_v128_load(rows + (2 * STEPS_PER_LATERAL_BLOCK));
        const v128_t fourth = wasm_v128_load(rows + (3 * STEPS_PER_LATERAL_BLOCK));
        const v128_t early_12 = wasm_i32x4_shuffle(first, second, 0, 4, 1, 5);
        const v128_t late_12 = wasm_i32x4_shuffle(first, second, 2, 6, 3, 7);
        const v128_t early_34 = wasm_i32x4_shuffle(third, fourth, 0, 4, 1, 5);
        const v128_t late_34 = wasm_i32x4_shuffle(third, fourth, 2, 6, 3, 7);
        float *steps = stepping.lateral_steps + (quarter * stepping.n_lanes) + river;
        wasm_v128_store(steps, wasm_i32x4_shuffle(early_12, early_34, 0, 1, 4, 5));
        wasm_v128_store(steps + stepping.n_lanes, wasm_i32x4_shuffle(early_12, early_34, 2, 3, 6, 7));
        wasm_v128_store(steps + (2 * stepping.n_lanes), wasm_i32x4_shuffle(late_12, late_34, 0, 1, 4, 5));
        wasm_v128_store(steps + (3 * stepping.n_lanes), wasm_i32x4_shuffle(late_12, late_34, 2, 3, 6, 7));
    }
    return OK;
}

/* Sum every river's runoff forcing for the STEPS_PER_LATERAL_BLOCK steps from first_step into lateral_steps. */
static int sum_lateral_of_block(struct stepping stepping, int first_step) {
    int problem = OK;
    for (int river = 0; river < stepping.n_lanes && problem == OK; river += 4) {
        problem = sum_lateral_of_four_rivers(stepping, first_step, river);
    }
    return problem;
}

/*
 * Push each series routed elsewhere into the forcing of the river it drains into, as c1 I[t] + c2 I[t-1] with that
 * river's c1 and c2.
 */
static void push_injected_series(struct stepping stepping, float *forcing, int step) {
    const struct network network = stepping.network;
    for (int injection = 0; injection < network.n_injected; injection++) {
        const int river = network.injected_rivers[injection];
        const float *series = network.injected_series + (injection * network.n_padded);
        const float before = step > 0 ? series[step - 1] : 0.0F;
        forcing[river] += (network.c1[river] * series[step]) + (network.c2[river] * before);
    }
}

/*
 * Route four rivers of one level one step, a lane each: each takes c3 times the discharge it held plus its forcing, its
 * runoff's and what its upstream rivers pushed into it, then pushes c1 times its new discharge plus c2 times its old
 * into the forcing of the river it drains into, with that river's c1 and c2, which sums them over its upstream rivers as
 * c1 I[t] + c2 I[t-1]. The pushes are made a lane at a time, since two rivers of the four may drain into the same river.
 */
static void route_four_rivers(struct stepping stepping, float *forcing, int river) {
    const v128_t before = wasm_v128_load(stepping.discharge + river);
    const v128_t now = multiply_add(wasm_v128_load(stepping.network.c3 + river), before,
                                    wasm_v128_load(forcing + river));
    wasm_v128_store(stepping.discharge + river, now);
    const v128_t push_before = wasm_f32x4_mul(wasm_v128_load(stepping.push_c2 + river), before);
    const v128_t push = multiply_add(wasm_v128_load(stepping.push_c1 + river), now, push_before);
    forcing[stepping.push_targets[river]] += wasm_f32x4_extract_lane(push, 0);
    forcing[stepping.push_targets[river + 1]] += wasm_f32x4_extract_lane(push, 1);
    forcing[stepping.push_targets[river + 2]] += wasm_f32x4_extract_lane(push, 2);
    forcing[stepping.push_targets[river + 3]] += wasm_f32x4_extract_lane(push, 3);
}

/* Route one river one step, as route_four_rivers routes each of its four. */
static void route_one_river(struct stepping stepping, float *forcing, int river) {
    const float before = stepping.discharge[river];
    const float now = (stepping.network.c3[river] * before) + forcing[river];
    stepping.discharge[river] = now;
    forcing[stepping.push_targets[river]] += (stepping.push_c1[river] * now) + (stepping.push_c2[river] * before);
}

/*
 * Route every river one step, a level at a time, four rivers to a vector and the rest of a level one by one, from
 * forcing, each river's forcing in level order, which its upstream rivers push into before it is routed.
 */
static void route_levels(struct stepping stepping, float *forcing) {
    for (int level = 0; level < stepping.n_levels; level++) {
        const int stop = stepping.level_starts[level + 1];
        int river = stepping.level_starts[level];
        for (; river + 4 <= stop; river += 4) {
            route_four_rivers(stepping, forcing, river);
        }
        for (; river < stop; river++) {
            route_one_river(stepping, forcing, river);
        }
    }
}

/* Route every river one step, forced by the step's row of lateral_steps and the series routed elsewhere. */
static void route_step(struct stepping stepping, int step) {
    float *forcing = stepping.lateral_steps + ((step % STEPS_PER_LATERAL_BLOCK) * stepping.n_lanes);
    push_injected_series(stepping, forcing, step);
    route_levels(stepping, forcing);
}

/*
 * Route up to n_steps more time steps, every river for each step before the next, from where the last call stopped,
 * writing each outlet's discharge into its row of outlet_series. Returns the steps left, or a problem.
 */
int route_next_steps(struct stepping *stepping, int n_steps) {
    if (stepping == 0) {
        return PROBLEM_MISSING_ARRAY;
    }
    struct stepping state = *stepping;
    const int n_left = state.n_steps - state.n_routed;
    if (n_steps < 1 || state.n_routed < 0) {
        return PROBLEM_SIZES;
    }
    if (n_left < 1) {
        return PROBLEM_STEPS_DONE;
    }
    const int stop = state.n_routed + (n_steps < n_left ? n_steps : n_left);
    int problem = OK;
    for (int step = state.n_routed; step < stop && problem == OK; step++) {
        problem = step % STEPS_PER_LATERAL_BLOCK == 0 ? sum_lateral_of_block(state, step) : OK;
        if (problem == OK) {
            route_step(state, step);
            for (int outlet = 0; outlet < state.n_outlets; outlet++) {
                state.outlet_series[(outlet * state.n_steps) + step] = state.discharge[state.outlets[outlet]];
            }
        }
    }
    state.n_routed = stop;
    *stepping = state;
    return problem == OK ? state.n_steps - stop : problem;
}

/*
 * Copy every river's discharge at the end of the last step routed into discharge in routing order, from level order:
 * level_positions holds the position in level order of each river in routing order. Returns OK or a problem.
 */
int copy_in_routing_order(const struct stepping *stepping, const int *level_positions, float *discharge) {
    if (stepping == 0 || level_positions == 0 || discharge == 0) {
        return PROBLEM_MISSING_ARRAY;
    }
    const int n_rivers = stepping->network.n_rivers;
    for (int river = 0; river < n_rivers; river++) {
        const int position = level_positions[river];
        if (position < 0 || position >= n_rivers) {
            return PROBLEM_SIZES;
        }
        discharge[river] = stepping->discharge[position];
    }
    return OK;
}

/*
 * The base 2 logarithm of four positive floats, none subnormal: each one's exponent, plus the logarithm of its mantissa,
 * from 1 up to 2, by a quadratic through log2(1) = 0 and log2(2) = 1 that is off by at most 0.0077.
 */
static inline v128_t log2_of_four(v128_t values) {
    const float squared = -0.34655F;
    const float linear = 2.03965F;
    const float constant = -1.6931F;
    const v128_t exponents = wasm_i32x4_sub(wasm_u32x4_shr(values, FLOAT_MANTISSA_BITS),
                                            wasm_i32x4_splat(FLOAT_EXPONENT_BIAS));
    const v128_t mantissas = wasm_v128_or(wasm_v128_and(values, wasm_i32x4_splat(FLOAT_MANTISSA)),
                                          wasm_i32x4_splat(FLOAT_ONE));
    const v128_t quadratic = multiply_add(multiply_add(wasm_f32x4_splat(squared), mantissas, wasm_f32x4_splat(linear)),
                                          mantissas, wasm_f32x4_splat(constant));
    return wasm_f32x4_add(wasm_f32x4_convert_i32x4(exponents), quadratic);
}

/*
 * Write every river's discharge class after the last step routed into class_values, in routing order, from level order
 * as copy_in_routing_order copies discharge: classes_per_tenfold classes to each tenfold of discharge above lowest, from
 * 0 at lowest and below up to top_class, left unrounded so that a caller can keep a margin between classes. Each is
 * off by at most 0.0077 log10(2) classes_per_tenfold, twice the error of log2_of_four. class_values holds n_rivers
 * rounded up to a whole number of vectors. Returns OK or a problem.
 */
int classify_in_routing_order(const struct stepping *stepping, const int *level_positions, float lowest,
                              float classes_per_tenfold, float top_class, float *class_values) {
    if (stepping == 0 || level_positions == 0 || class_values == 0) {
        return PROBLEM_MISSING_ARRAY;
    }
    if (!(lowest > 0.0F) || !(classes_per_tenfold > 0.0F) || !(top_class > 0.0F)) {
        return PROBLEM_CLASSES;
    }
    const float log10_of_2 = 0.30103F;
    const int n_rivers = stepping->network.n_rivers;
    const v128_t lowest_everywhere = wasm_f32x4_splat(lowest);
    const v128_t scale = wasm_f32x4_splat(log10_of_2 * classes_per_tenfold);
    const v128_t offset = wasm_f32x4_mul(log2_of_four(lowest_everywhere), wasm_f32x4_neg(scale));
    for (int river = 0; river < n_rivers; river += 4) {
        float discharge[4] = {lowest, lowest, lowest, lowest}; /* past the last river, lowest */
        for (int lane = 0; lane < 4 && river + lane < n_rivers; lane++) {
            const int position = level_positions[river + lane];
            if (position < 0 || position >= n_rivers) {
                return PROBLEM_SIZES;
            }
            discharge[lane] = stepping->discharge[position];
        }
        const v128_t above_lowest = wasm_f32x4_max(wasm_v128_load(discharge), lowest_everywhere);
        const v128_t classes = multiply_add(log2_of_four(above_lowest), scale, offset);
        wasm_v128_store(class_values + river,
                        wasm_f32x4_min(wasm_f32x4_max(classes, wasm_f32x4_splat(0.0F)), wasm_f32x4_splat(top_class)));
    }
    return OK;
}

/* The floats of scratch start_live_stepping needs for n_rivers rivers, its pushes, or 0 for a bad count. */
int live_scratch_floats(int n_rivers) {
    return 2 * vector_lanes(n_rivers);
}

/*
 * Check a network, whose rivers come in the order of their topological levels, and set it up to be routed live: one
 * step at a time with the runoff forcing its caller gives each step to route_live_step, from no discharge. Returns OK
 * or a problem. The caller lays out every array: discharge holds n_rivers floats, scratch_floats
 * live_scratch_floats(n_rivers) floats, scratch_ints stepping_scratch_ints(n_rivers, n_outlets) ints, and stepping
 * stepping_size() bytes.
 */
int start_live_stepping(struct stepping *stepping, int n_rivers, int n_levels, int n_outlets, const int *level_starts,
                        const int *downstream_positions, const float *c1, const float *c2, const float *c3,
                        float *discharge, float *scratch_floats, int *scratch_ints) {
    if (stepping_scratch_ints(n_rivers, n_outlets) == 0) {
        return PROBLEM_SIZES;
    }
    const int arrays_missing = stepping == 0 || c1 == 0 || c2 == 0 || c3 == 0 || discharge == 0 || scratch_floats == 0
                               || scratch_ints == 0;
    int problem = arrays_missing ? PROBLEM_MISSING_ARRAY : OK;
    problem = problem == OK ? check_topology(n_rivers, downstream_positions, 0, 0) : problem;
    problem = problem == OK ? check_levels(n_rivers, n_levels, level_starts, downstream_positions) : problem;
    if (problem != OK) {
        return problem;
    }
    const struct network network = {n_rivers, 0, 0, downstream_positions, c1, c2, c3, 0, 0, 0, 0, 0, 0};
    const struct stepping started = {network, 0, n_levels, vector_lanes(n_rivers), n_outlets, 0, level_starts, discharge,
                                     0, 0, 0, 0, 0, 0, 0};
    *stepping = started;
    for (int river = 0; river < n_rivers; river++) {
        discharge[river] = 0.0F;
    }
    return set_up_pushes(stepping, scratch_floats, scratch_ints) == n_outlets ? OK : PROBLEM_OUTLETS;
}

/*
 * Route every river of a live stepping one step, forced by forcing: each river's runoff forcing for the step in level
 * order, n_lanes floats, which its upstream rivers push into as the step is routed, and which is zeroed after, ready
 * for the next step's. Returns OK or a problem.
 */
int route_live_step(struct stepping *stepping, float *forcing) {
    if (stepping == 0 || forcing == 0) {
        return PROBLEM_MISSING_ARRAY;
    }
    if (stepping->n_lanes < 4 || stepping->push_targets == 0 || stepping->discharge == 0) {
        return PROBLEM_LEVELS; /* not started */
    }
    route_levels(*stepping, forcing);
    for (int lane = 0; lane < stepping->n_lanes; lane++) {
        forcing[lane] = 0.0F;
    }
    return OK;
}

/*
 * Set every river's discharge, as if routed to it, from discharge in routing order, into level order as
 * level_positions, the position in level order of each river in routing order, gives. Returns OK or a problem.
 */
int set_discharge_in_routing_order(struct stepping *stepping, const int *level_positions, const float *discharge) {
    if (stepping == 0 || level_positions == 0 || discharge == 0 || stepping->discharge == 0) {
        return PROBLEM_MISSING_ARRAY;
    }
    const int n_rivers = stepping->network.n_rivers;
    for (int river = 0; river < n_rivers; river++) {
        const int position = level_positions[river];
        if (position < 0 || position >= n_rivers) {
            return PROBLEM_SIZES;
        }
        stepping->discharge[position] = discharge[river];
    }
    return OK;
}
