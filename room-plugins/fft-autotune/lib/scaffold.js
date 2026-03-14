import fs from 'node:fs';
import path from 'node:path';

// The universal harness template. Parameterized via -DDFT_SIZE=N -DDFT_FUNC=func_name.
// Handles: deterministic validation vectors, adaptive iteration calibration, benchmark
// with warmups/trials, and writes validation.json + benchmark.json.
//
// Usage:
//   clang -O3 -ffast-math -march=native \
//     -DDFT_SIZE=64 -DDFT_FUNC=dft_64 \
//     my_fft.c harness.c -o out.bin -lm
//   ./out.bin <validation_samples> <warmups> <trials> <validation.json> <benchmark.json>
const HARNESS_TEMPLATE = `\
#include <complex.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifndef DFT_SIZE
#error "DFT_SIZE must be defined"
#endif

#ifndef DFT_FUNC
#error "DFT_FUNC must be defined"
#endif

#ifndef INITIAL_ITERS
#define INITIAL_ITERS 64
#endif

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

void DFT_FUNC(const complex float* input, complex float* output);

static complex float twiddle_table[DFT_SIZE];

static uint32_t xorshift32(uint32_t* state) {
    uint32_t x = *state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *state = x;
    return x;
}

static float rng_float_signed(uint32_t* state) {
    return ((float)(xorshift32(state) & 0x00ffffffu) / 8388608.0f) - 1.0f;
}

static inline complex float cmul(complex float a, complex float b) {
    float ar = crealf(a);
    float ai = cimagf(a);
    float br = crealf(b);
    float bi = cimagf(b);
    return (ar * br - ai * bi) + I * (ar * bi + ai * br);
}

static void init_twiddles(void) {
    for (int i = 0; i < DFT_SIZE; ++i) {
        float angle = -2.0f * (float)M_PI * (float)i / (float)DFT_SIZE;
        twiddle_table[i] = cosf(angle) + I * sinf(angle);
    }
}

static void reference_dft(const complex float* input, complex float* output) {
    for (int k = 0; k < DFT_SIZE; ++k) {
        complex float acc = 0.0f + 0.0f * I;
        for (int n = 0; n < DFT_SIZE; ++n) {
            acc += cmul(input[n], twiddle_table[(k * n) % DFT_SIZE]);
        }
        output[k] = acc;
    }
}

static const char* validation_case_name(int sample_index) {
    switch (sample_index) {
        case 0: return "impulse";
        case 1: return "all-ones";
        case 2: return "single-tone";
        case 3: return "alternating-sign";
        default: return "fixed-seed-random";
    }
}

static void fill_validation_case(int sample_index, uint32_t* random_state, complex float* input) {
    for (int i = 0; i < DFT_SIZE; ++i) {
        input[i] = 0.0f + 0.0f * I;
    }

    switch (sample_index) {
        case 0:
            input[0] = 1.0f + 0.0f * I;
            break;
        case 1:
            for (int i = 0; i < DFT_SIZE; ++i) {
                input[i] = 1.0f + 0.0f * I;
            }
            break;
        case 2: {
            const int tone = 3;
            for (int n = 0; n < DFT_SIZE; ++n) {
                float angle = 2.0f * (float)M_PI * (float)(tone * n) / (float)DFT_SIZE;
                input[n] = cosf(angle) + I * sinf(angle);
            }
            break;
        }
        case 3:
            for (int n = 0; n < DFT_SIZE; ++n) {
                input[n] = (n & 1) ? (-1.0f + 0.0f * I) : (1.0f + 0.0f * I);
            }
            break;
        default:
            for (int i = 0; i < DFT_SIZE; ++i) {
                input[i] = rng_float_signed(random_state) + I * rng_float_signed(random_state);
            }
            break;
    }
}

static uint64_t now_ns(void) {
#if defined(__APPLE__)
    return clock_gettime_nsec_np(CLOCK_UPTIME_RAW);
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ull + (uint64_t)ts.tv_nsec;
#endif
}

static int cmp_double(const void* a, const void* b) {
    double da = *(const double*)a;
    double db = *(const double*)b;
    return (da > db) - (da < db);
}

static int write_validation_json(const char* path,
                                 int ok,
                                 int sample_count,
                                 float max_error,
                                 float tolerance,
                                 const char* failure_reason,
                                 const char* first_fail_case,
                                 int first_fail_index,
                                 float first_fail_error) {
    FILE* f = fopen(path, "w");
    if (!f) return 0;
    fprintf(f,
            "{\\n"
            "  \\"ok\\": %s,\\n"
            "  \\"sampleCount\\": %d,\\n"
            "  \\"maxError\\": %.9g,\\n"
            "  \\"tolerance\\": %.9g,\\n"
            "  \\"failureReason\\": \\"%s\\",\\n"
            "  \\"firstFailInputLabel\\": \\"%s\\",\\n"
            "  \\"firstFailIndex\\": %d,\\n"
            "  \\"firstFailError\\": %.9g,\\n"
            "  \\"deterministicCases\\": [\\"impulse\\", \\"all-ones\\", \\"single-tone\\", \\"alternating-sign\\"]\\n"
            "}\\n",
            ok ? "true" : "false",
            sample_count,
            (double)max_error,
            (double)tolerance,
            failure_reason ? failure_reason : "",
            first_fail_case ? first_fail_case : "",
            first_fail_index,
            (double)first_fail_error);
    fclose(f);
    return 1;
}

static int write_benchmark_json(const char* path,
                                int ok,
                                int warmups,
                                int trials,
                                int iterations_per_trial,
                                double median_ns,
                                double p95_ns,
                                double cv_pct,
                                double mean_ns,
                                double sink) {
    FILE* f = fopen(path, "w");
    if (!f) return 0;
    fprintf(f,
            "{\\n"
            "  \\"ok\\": %s,\\n"
            "  \\"warmups\\": %d,\\n"
            "  \\"trials\\": %d,\\n"
            "  \\"iterationsPerTrial\\": %d,\\n"
            "  \\"medianNs\\": %.6f,\\n"
            "  \\"p95Ns\\": %.6f,\\n"
            "  \\"cvPct\\": %.6f,\\n"
            "  \\"meanNs\\": %.6f,\\n"
            "  \\"sink\\": %.9f\\n"
            "}\\n",
            ok ? "true" : "false",
            warmups,
            trials,
            iterations_per_trial,
            median_ns,
            p95_ns,
            cv_pct,
            mean_ns,
            sink);
    fclose(f);
    return 1;
}

int main(int argc, char** argv) {
    if (argc != 6) {
        fprintf(stderr, "usage: %s <validation_samples> <warmups> <trials> <validation_json> <benchmark_json>\\n", argv[0]);
        return 64;
    }

    const int validation_samples = atoi(argv[1]);
    const int warmups = atoi(argv[2]);
    const int trials = atoi(argv[3]);
    const char* validation_path = argv[4];
    const char* benchmark_path = argv[5];
    const float tolerance = 1.0e-3f;

    init_twiddles();

    float max_error = 0.0f;
    int validation_ok = 1;
    char failure_reason[256];
    failure_reason[0] = '\\0';
    const char* first_fail_case = NULL;
    int first_fail_index = -1;
    float first_fail_error = 0.0f;
    uint32_t validation_state = 0x12345678u;

    for (int sample = 0; sample < validation_samples; ++sample) {
        complex float input[DFT_SIZE];
        complex float actual[DFT_SIZE];
        complex float reference[DFT_SIZE];
        fill_validation_case(sample, &validation_state, input);
        DFT_FUNC(input, actual);
        reference_dft(input, reference);

        for (int i = 0; i < DFT_SIZE; ++i) {
            float dr = crealf(actual[i]) - crealf(reference[i]);
            float di = cimagf(actual[i]) - cimagf(reference[i]);
            float err = sqrtf(dr * dr + di * di);
            if (err > max_error) {
                max_error = err;
            }
            if (err > tolerance && validation_ok) {
                validation_ok = 0;
                first_fail_case = validation_case_name(sample);
                first_fail_index = i;
                first_fail_error = err;
                snprintf(failure_reason,
                         sizeof(failure_reason),
                         "sample=%d case=%s index=%d error=%.9g tolerance=%.9g",
                         sample,
                         validation_case_name(sample),
                         i,
                         (double)err,
                         (double)tolerance);
            }
        }
    }

    if (!write_validation_json(validation_path,
                               validation_ok,
                               validation_samples,
                               max_error,
                               tolerance,
                               failure_reason,
                               first_fail_case,
                               first_fail_index,
                               first_fail_error)) {
        fprintf(stderr, "failed to write validation json\\n");
        return 65;
    }

    if (!validation_ok) {
        return 2;
    }

    complex float bench_inputs[16][DFT_SIZE];
    uint32_t bench_state = 0x87654321u;
    for (int s = 0; s < 16; ++s) {
        for (int i = 0; i < DFT_SIZE; ++i) {
            bench_inputs[s][i] = rng_float_signed(&bench_state) + I * rng_float_signed(&bench_state);
        }
    }

    complex float output[DFT_SIZE];
    volatile float sink = 0.0f;
    int iterations_per_trial = INITIAL_ITERS;

    while (iterations_per_trial < (1 << 20)) {
        uint64_t t0 = now_ns();
        for (int iter = 0; iter < iterations_per_trial; ++iter) {
            DFT_FUNC(bench_inputs[iter & 15], output);
            sink += crealf(output[iter & (DFT_SIZE - 1)]);
        }
        uint64_t t1 = now_ns();
        if ((t1 - t0) >= 2000000ull) {
            break;
        }
        iterations_per_trial <<= 1;
    }

    for (int w = 0; w < warmups; ++w) {
        for (int iter = 0; iter < iterations_per_trial; ++iter) {
            DFT_FUNC(bench_inputs[iter & 15], output);
            sink += crealf(output[(iter + w) & (DFT_SIZE - 1)]);
        }
    }

    if (trials > 256) {
        fprintf(stderr, "too many trials\\n");
        return 66;
    }

    double samples[256];
    for (int t = 0; t < trials; ++t) {
        uint64_t t0 = now_ns();
        for (int iter = 0; iter < iterations_per_trial; ++iter) {
            DFT_FUNC(bench_inputs[(iter + t) & 15], output);
            sink += crealf(output[(iter + t) & (DFT_SIZE - 1)]);
        }
        uint64_t t1 = now_ns();
        samples[t] = (double)(t1 - t0) / (double)iterations_per_trial;
    }

    double sorted[256];
    memcpy(sorted, samples, (size_t)trials * sizeof(double));
    qsort(sorted, (size_t)trials, sizeof(double), cmp_double);

    const double median_ns = (trials % 2 == 0)
        ? 0.5 * (sorted[trials / 2 - 1] + sorted[trials / 2])
        : sorted[trials / 2];
    int p95_index = (int)ceil(0.95 * (double)trials) - 1;
    if (p95_index < 0) p95_index = 0;
    if (p95_index >= trials) p95_index = trials - 1;
    const double p95_ns = sorted[p95_index];

    double mean_ns = 0.0;
    for (int t = 0; t < trials; ++t) {
        mean_ns += samples[t];
    }
    mean_ns /= (double)trials;

    double variance = 0.0;
    for (int t = 0; t < trials; ++t) {
        double d = samples[t] - mean_ns;
        variance += d * d;
    }
    variance /= (double)trials;
    const double cv_pct = mean_ns > 0.0 ? (sqrt(variance) / mean_ns) * 100.0 : 0.0;

    if (!write_benchmark_json(benchmark_path,
                              1,
                              warmups,
                              trials,
                              iterations_per_trial,
                              median_ns,
                              p95_ns,
                              cv_pct,
                              mean_ns,
                              sink)) {
        fprintf(stderr, "failed to write benchmark json\\n");
        return 67;
    }

    return 0;
}
`;

const HARNESS_USAGE = `\
FFT Autotune Harness
====================

This directory contains a universal validation+benchmark harness (harness.c).
Use it for ALL FFT candidates and baselines. Do NOT write custom harnesses.

Your FFT source file must export a function with this signature:
  void dft_<N>(const complex float* input, complex float* output);

For example, for N=64:
  void dft_64(const complex float* input, complex float* output);

Compile
-------
  clang -O3 -ffast-math -march=native \\
    -DDFT_SIZE=64 -DDFT_FUNC=dft_64 \\
    my_fft64.c harness.c -o my_fft64.bin -lm

Run
---
  ./my_fft64.bin <validation_samples> <warmups> <trials> <validation.json> <benchmark.json>

  Example:
  ./my_fft64.bin 64 5 30 my_fft64.validation.json my_fft64.bench.json

Exit codes:
  0  = validation passed + benchmark written
  2  = validation failed (validation.json still written with diagnostics)
  64 = bad arguments
  65 = cannot write validation json
  66 = too many trials (max 256)
  67 = cannot write benchmark json

Output JSON
-----------
validation.json contains: ok, sampleCount, maxError, tolerance, failureReason,
  firstFailInputLabel, firstFailIndex, firstFailError, deterministicCases

benchmark.json contains: ok, warmups, trials, iterationsPerTrial,
  medianNs, p95Ns, cvPct, meanNs, sink

Validation vectors (in order): impulse, all-ones, single-tone, alternating-sign,
then fixed-seed random inputs.

Important
---------
- The harness includes a built-in O(N^2) reference DFT for validation.
- Timing uses clock_gettime_nsec_np (macOS) or clock_gettime (Linux).
- Iteration count auto-calibrates so each trial takes >= 2ms.
- Do NOT modify harness.c. If you need a different interface, adapt your FFT
  source to match the expected signature above.
`;

export function scaffoldWorkspace(outputDir) {
  const actions = [];

  const harnessPath = path.join(outputDir, 'harness.c');
  const existingHarness = fs.existsSync(harnessPath) ? fs.readFileSync(harnessPath, 'utf-8') : null;
  if (existingHarness !== HARNESS_TEMPLATE) {
    fs.writeFileSync(harnessPath, HARNESS_TEMPLATE, 'utf-8');
    actions.push(existingHarness === null
      ? `Created harness ${harnessPath}`
      : `Updated harness ${harnessPath}`);
  }

  const usagePath = path.join(outputDir, 'HARNESS_USAGE.txt');
  const existingUsage = fs.existsSync(usagePath) ? fs.readFileSync(usagePath, 'utf-8') : null;
  if (existingUsage !== HARNESS_USAGE) {
    fs.writeFileSync(usagePath, HARNESS_USAGE, 'utf-8');
    actions.push(existingUsage === null
      ? `Created harness usage guide ${usagePath}`
      : `Updated harness usage guide ${usagePath}`);
  }

  return actions;
}

export function getHarnessCompileHint(config) {
  const flags = config.compilerFlags.join(' ');
  return [
    `A universal harness is provided at: ${config.outputDir}/harness.c`,
    'Your FFT source must export: void dft_<N>(const complex float* input, complex float* output);',
    `Compile: ${config.compilerCommand} ${flags} -DDFT_SIZE=<N> -DDFT_FUNC=dft_<N> your_fft.c ${config.outputDir}/harness.c -o out.bin -lm`,
    `Run:     ./out.bin ${config.validationSamples} ${config.benchmarkWarmups} ${config.benchmarkTrials} validation.json benchmark.json`,
    'Do NOT write custom harnesses. Use harness.c for all candidates.',
  ].join('\n');
}
