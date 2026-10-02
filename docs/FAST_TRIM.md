# Fast trimming — 2026-10-02

S06/S07, A08–A12: simple trims can use native FFmpeg stream copy, following the approach described by [LosslessCut](https://github.com/mifi/lossless-cut). No LosslessCut source code was copied.

The former automatic path encoded every partial selection. Its explicit copy path tested encoders, scanned source keyframes, compared two fully decoded frame hashes, and decoded the entire output again. Fast copies now skip encoder tests, use bounded packet lookups near the cut points, probe the result, and decode up to half a second at either edge. Full verification remains selectable. Encoded exports retain full validation.

New editor sessions use automatic lossless trimming. Existing drafts, projects, presets, exact cuts and compression targets retain their intent. MP4 copying uses a conservative codec eligibility list. Multi-cut export copies each section and concatenates it in recipe order; adjacent splits coalesce before keyframe resolution. Each separate section expands to usable keyframes, so short removed gaps can reappear and resolved sections can overlap. Exact mode is required when those boundaries must be precise. The result panel shows the actual kept ranges.

Ordinary seek feedback is immediate even while indexed snapping loads. Draft storage is debounced during dragging and flushed on navigation/page exit. Active jobs refresh every 300 ms instead of 1.8 seconds, without overlapping polling requests.

## Measured evidence

A generated 60-second 1920×1080 H.264/AAC source was trimmed from requested 20.2–40.5 seconds to resolved keyframes 20–42 seconds:

| Verification | Export time | Output bytes |
| --- | ---: | ---: |
| Fast | 413 ms | 40,699,939 |
| Full | 8,319 ms | 40,699,939 |

Both files had SHA-256 `9e7898384eb2ae90cf7dae7c26228ccbb3c4faa2b3144ebfcbb5054195aa2b36` and passed an independent full decode. This measures the native export operation on this Windows machine, excluding file import, queue waiting and browser playback startup. Files still require disk I/O; these timings are not a universal latency guarantee. Machine-readable measurements: `test-output/trim-speed/benchmark.json`.

The copy tests independently compare every decoded output frame against the selected source frames for H.264 CFR, B-frames, VFR, nonzero timestamp origin, rational NTSC, and AV1. Multi-cut tests check recipe order, adjacent splits, preserved audio, duration and decoding. The generated browser test covers trim controls, drag/undo, desktop/mobile, actual lossless preview, unchanged source bytes and draft restoration.

Validation commands use the staged Node 22 runtime (`.tools/node.exe`), because the machine's default Node is older. Core suite: `--import tsx --test --test-concurrency=1 tests/copy-validation.test.ts tests/media.test.ts tests/drafts.test.ts tests/security-contracts.test.ts`; browser: `--import tsx tests/clip-edit.smoke.ts`. Full suite and packaging results are recorded in the implementation ledger.

Final full suite: 129 passed, 0 failed, 15 platform/opt-in skips. Build/typecheck and the trim browser test passed. The rebuilt Windows executable passed `tests/fast-trim-desktop.smoke.ts`: requested 2.4–6.7 s resolved to 2–7 s, retained playable audio/video, preserved the source, and displayed the preview in 1,381 ms. The broader responsive suite still flags four existing 40 px mobile audio buttons against its 44 px minimum; trim-specific mobile checks pass.

Fast validation checks structure and cut edges, not corruption elsewhere in the file. Full verification remains available for that requirement. Shared-worker quotas remain enforced; multi-section scratch can hit that quota sooner than a single-section export. Linux desktop and universal codec compatibility were not verified in this follow-up.
