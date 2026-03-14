#include <complex.h>
#include <stddef.h>

#include "third_party/ne10/inc/NE10_dsp.h"
#include "third_party/ne10/modules/dsp/NE10_fft.h"

typedef struct {
    ne10_int32_t nfft;
    ne10_fft_cfg_float32_t cfg;
    ne10_fft_cpx_float32_t inbuf[1024];
    ne10_fft_cpx_float32_t outbuf[1024];
    int init_failed;
} ne10_cached_plan_t;

// Ne10's NEON C2C allocator references this int32 fallback symbol from the same
// translation unit, even though the FFT room only uses the FP32 path.
ne10_fft_cfg_int32_t ne10_fft_alloc_c2c_int32_c(ne10_int32_t nfft) {
    (void) nfft;
    return NULL;
}

// The intrinsic FP32 C2C entrypoint also references the generic NEON path for
// non-power-of-two FFTs. The room only scaffolds power-of-two buckets, so we
// satisfy the symbol with a safe fallback to Ne10's generic C implementation.
void ne10_mixed_radix_generic_butterfly_float32_neon(
    ne10_fft_cpx_float32_t *fout,
    const ne10_fft_cpx_float32_t *fin,
    const ne10_int32_t *factors,
    const ne10_fft_cpx_float32_t *twiddles,
    ne10_fft_cpx_float32_t *buffer,
    const ne10_int32_t is_scaled) {
    ne10_mixed_radix_generic_butterfly_float32_c(fout, fin, factors, twiddles, buffer, is_scaled);
}

void ne10_mixed_radix_generic_butterfly_inverse_float32_neon(
    ne10_fft_cpx_float32_t *fout,
    const ne10_fft_cpx_float32_t *fin,
    const ne10_int32_t *factors,
    const ne10_fft_cpx_float32_t *twiddles,
    ne10_fft_cpx_float32_t *buffer,
    const ne10_int32_t is_scaled) {
    ne10_mixed_radix_generic_butterfly_inverse_float32_c(fout, fin, factors, twiddles, buffer, is_scaled);
}

static ne10_cached_plan_t ne10_plan_64 = { 64, NULL, {{0}}, {{0}}, 0 };
static ne10_cached_plan_t ne10_plan_256 = { 256, NULL, {{0}}, {{0}}, 0 };
static ne10_cached_plan_t ne10_plan_1024 = { 1024, NULL, {{0}}, {{0}}, 0 };

static ne10_cached_plan_t* ne10_cached_plan_for_size(ne10_int32_t nfft) {
    switch (nfft) {
        case 64:
            return &ne10_plan_64;
        case 256:
            return &ne10_plan_256;
        case 1024:
            return &ne10_plan_1024;
        default:
            return NULL;
    }
}

static ne10_fft_cfg_float32_t ne10_get_cached_cfg(ne10_cached_plan_t* plan) {
    if (plan == NULL) {
        return NULL;
    }
    if (plan->cfg != NULL) {
        return plan->cfg;
    }
    if (plan->init_failed) {
        return NULL;
    }

    plan->cfg = ne10_fft_alloc_c2c_float32_neon(plan->nfft);
    if (plan->cfg == NULL) {
        plan->init_failed = 1;
    }
    return plan->cfg;
}

__attribute__((destructor))
static void ne10_release_cached_plans(void) {
    if (ne10_plan_64.cfg != NULL) {
        ne10_fft_destroy_c2c_float32(ne10_plan_64.cfg);
        ne10_plan_64.cfg = NULL;
    }
    if (ne10_plan_256.cfg != NULL) {
        ne10_fft_destroy_c2c_float32(ne10_plan_256.cfg);
        ne10_plan_256.cfg = NULL;
    }
    if (ne10_plan_1024.cfg != NULL) {
        ne10_fft_destroy_c2c_float32(ne10_plan_1024.cfg);
        ne10_plan_1024.cfg = NULL;
    }
}

static void ne10_reference_fft(
    ne10_int32_t nfft,
    const complex float *input,
    complex float *output) {
    ne10_cached_plan_t* plan = ne10_cached_plan_for_size(nfft);
    ne10_fft_cfg_float32_t cfg = ne10_get_cached_cfg(plan);
    if (cfg == NULL) {
        for (ne10_int32_t i = 0; i < nfft; ++i) {
            output[i] = 0.0f + 0.0f * I;
        }
        return;
    }

    for (ne10_int32_t i = 0; i < nfft; ++i) {
        plan->inbuf[i].r = crealf(input[i]);
        plan->inbuf[i].i = cimagf(input[i]);
    }

    ne10_fft_c2c_1d_float32_neon(plan->outbuf, plan->inbuf, cfg, 0);

    for (ne10_int32_t i = 0; i < nfft; ++i) {
        output[i] = plan->outbuf[i].r + plan->outbuf[i].i * I;
    }
}

void dft_64(const complex float *input, complex float *output) {
    ne10_reference_fft(64, input, output);
}

void dft_256(const complex float *input, complex float *output) {
    ne10_reference_fft(256, input, output);
}

void dft_1024(const complex float *input, complex float *output) {
    ne10_reference_fft(1024, input, output);
}
