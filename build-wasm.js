/**
 * Check src/muskingum.c with two static analyzers, then compile it to two modules, stopping at any warning: one with
 * WebAssembly's relaxed SIMD, whose fused multiply and add routes faster, and one without, for browsers that lack it.
 * NASA's rules for C ask for every warning at its most pedantic and a strong static analyzer, all passed clean.
 *
 *     node build-wasm.js
 *
 * LLVM_BIN and LLD_BIN name the folders of clang and wasm-ld, by default Homebrew's llvm@22 and lld@22.
 */
import { execFileSync } from 'node:child_process'

const LLVM_BIN = process.env.LLVM_BIN ?? '/opt/homebrew/opt/llvm@22/bin'
const LLD_BIN = process.env.LLD_BIN ?? '/opt/homebrew/opt/lld@22/bin'
const SOURCE = 'src/muskingum.c'
const MODULES = { 'src/muskingum-relaxed.wasm': ['-mrelaxed-simd'], 'src/muskingum.wasm': [] } // output: features
const EXPORTS = [
  'padded_steps', 'row_stride', 'describe_problem', 'count_peak_inflow_rows', 'routing_size', 'start_routing',
  'route_next_rivers', 'next_window', 'stepping_size', 'stepping_scratch_floats', 'stepping_scratch_ints',
  'start_stepping', 'route_next_steps', 'copy_in_routing_order', 'classify_in_routing_order', 'live_scratch_floats',
  'start_live_stepping', 'route_live_step', 'set_discharge_in_routing_order',
]

const TARGET = [
  '--target=wasm32', // 32 bit WebAssembly, which every browser runs
  '-std=c17',
  '-msimd128', // 128 bit vectors, which every browser has run since 2023
  '-mbulk-memory', // lets clang fill memory with one instruction rather than call a memset there is no library for
  '-ffreestanding', // no C library: nothing is included but the compiler's own wasm_simd128.h
]

const WARNINGS = [
  '-Weverything', // every warning clang has
  '-Werror',
  // C89's rule to declare variables before statements; NASA's rule 6 declares each at the smallest scope instead
  '-Wno-declaration-after-statement',
  // C++'s safe buffers, which ask for std::span in place of indexing a pointer; C has no other way to index an array
  '-Wno-unsafe-buffer-usage',
]

// the analyzer's checkers of C, beyond its defaults: dead code, null pointers, portability, performance, and security
const ANALYZER_CHECKERS = '-analyzer-checker=core,deadcode,nullability,optin.core,optin.performance,optin.portability,'
  + 'security,unix'

const TIDY_CHECKS = [
  'bugprone-*', 'cert-*', 'clang-analyzer-*', 'misc-*', 'performance-*', 'portability-*', 'readability-*', 'hicpp-*',
  'cppcoreguidelines-*',
  // the exported functions have external linkage so that the linker can export them to JavaScript
  '-misc-use-internal-linkage',
  // the exported functions take every array and count separately, as a WebAssembly module's exports must; each checks
  // its arguments instead
  '-bugprone-easily-swappable-parameters',
]
// the Muskingum coefficients keep their names, c1 to c4, which are shorter than readability-identifier-length allows
const TIDY_OPTIONS = '{CheckOptions: {readability-identifier-length.IgnoredParameterNames: "^c[1-4]$", '
  + 'readability-identifier-length.IgnoredVariableNames: "^c[1-4]$"}}'

const LINK = [
  '-nostdlib',
  `-Wl,--no-entry`, // a library of functions, with no main
  ...EXPORTS.map(name => `-Wl,--export=${name}`),
  '-Wl,--export=__heap_base', // where free memory starts, after the stack, for muskingum-wasm.js to lay arrays out from
  '-Wl,--max-memory=4294967296', // all 4 GB a 32 bit module can address
]

function run(program, args, env = process.env) {
  execFileSync(program, args, { stdio: 'inherit', env })
}

for (const [output, features] of Object.entries(MODULES)) {
  const target = [...TARGET, ...features]
  run(`${LLVM_BIN}/clang-tidy`, [SOURCE, '--quiet', '--warnings-as-errors=*', `--checks=-*,${TIDY_CHECKS.join(',')}`,
    `--config=${TIDY_OPTIONS}`, '--', ...target])
  run(`${LLVM_BIN}/clang`, ['--analyze', ...target, '-Xclang', '-analyzer-werror', '-Xclang', ANALYZER_CHECKERS,
    '-o', '/dev/null', SOURCE])
  run(`${LLVM_BIN}/clang`, [...target, ...WARNINGS, '-O3', ...LINK, '-o', output, SOURCE],
    { ...process.env, PATH: `${LLD_BIN}:${process.env.PATH}` }) // clang finds wasm-ld by name on the PATH
  console.log(`built ${output}`)
}
