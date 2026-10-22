#include <metal_stdlib>
using namespace metal;

// The imagery placeholder shader (DS §1.5): three soft color fields breathing into each
// other, plus film grain so the ramps never band. Deterministic per seed — the same save
// renders the same wash on every launch, exactly like FeedWash's old flat tones did.

static float hash21(float2 p) {
    p = fract(p * float2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

[[ stitchable ]] half4 coWash(float2 position, half4 color, float2 size, float seed,
                               float grain, half4 c0, half4 c1, half4 c2) {
    float2 uv = position / max(size, float2(1.0, 1.0));

    // Three blob centers derived from the seed, pushed toward different corners so the
    // field always has a diagonal drift rather than a centered spotlight.
    float2 a = float2(fract(seed * 0.731),        fract(seed * 0.317) * 0.6);
    float2 b = float2(fract(seed * 0.533 + 0.41), fract(seed * 0.911 + 0.17));
    float2 c = float2(fract(seed * 0.201 + 0.73), fract(seed * 0.147 + 0.59));

    // Falloff tuned so each center keeps its own hue at its corner instead of every
    // pixel averaging toward the palette's mean — the drift should read iridescent,
    // not uniformly gray.
    float wa = exp(-4.5 * distance(uv, a));
    float wb = exp(-4.5 * distance(uv, b));
    float wc = exp(-4.5 * distance(uv, c));
    float sum = wa + wb + wc;

    half3 col = (half3(c0.rgb) * wa + half3(c1.rgb) * wb + half3(c2.rgb) * wc) / sum;

    // Grain + a whisper of dither. Position is in points, so the grain reads as film,
    // not as per-device pixel noise. Amplitude is the caller's: feed tiles whisper (0.06),
    // the onboarding backdrop speaks up (~0.12) so the ramp reads as paper, not a gradient.
    float g = hash21(position + fract(seed) * 100.0) - 0.5;
    col += half3(g * grain);

    return half4(col, color.a);
}
