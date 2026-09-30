# Rendered export preview

The editor's **Preview video** button renders the full current recipe with its export options and preset through the real authenticated export queue, then plays the specific completed job's validated artifact. It does not approximate cuts by seeking around the original, reduce preview quality, or substitute a proxy. **Play source region** remains a separate source-inspection action.

Implementation: `apps/web/src/RenderedPreview.tsx`, integration in `main.tsx`, source-player pause signal in `CutWorkspace.tsx`, and modal styles in `styles.css`. Existing backend planning, permissions, quota, cancellation, validation and artifact delivery are reused. This extends A08–A12 and S06/S07 without moving media processing into presentation code.

The modal shows rendering progress and the actual plan, supports cancellation, and offers the completed file for download. Starting it pauses source playback. Closing it stops/unmounts output playback while any active render remains visible in Queue. Completed renders are regular managed exports in Library, with normal ownership and retention. Unchanged intent reuses the validated result; source/recipe/options/preset changes invalidate reuse. An earlier active render remains accessible for cancellation rather than disabling the only preview button. Cancellation immediately prevents automatic playback.

Rendering can take as long as exporting. Browser codec support still determines whether the resulting file can be played inline; a playback error offers the actual file for inspection in a compatible player rather than falsely reporting media render failure.

## Observed tests

`npm run build` and `npm run typecheck` passed. The browser suite passed **31 checks** at 16:39:09 UTC on 12 September 2026, including the preceding editor/download/lifecycle checks and these new observations:

- A real edited preview with crop, rotation, resize, timed text, captions and audio settings produced **14,019 bytes**, **160 × 100**, **0.8 seconds**, below the **30,000-byte ceiling**. Full FFmpeg decoding yielded the same **eight frame hashes** as the separately exported file using identical intent.
- Closing stopped playback. Reopening unchanged settings reused the same artifact without creating another export job.
- Changing the text produced a new artifact; its extracted PNG visibly reads “Changed preview”.
- Stream-copy preview for requested `[0.5, 1.5)` played the real keyframe-adjusted result: **121,309 bytes**, **2.005333 seconds** of container duration, **20 decoded video frames** matching the resolved original-source interval. The modal separately reports the 2.000-second planned video interval.

Screenshots of both preview modes and the changed-text frame were inspected. Evidence: `test-output/browser/evidence.json`, `rendered-preview.mp4`, `rendered-preview.png`, `changed-preview.mp4`, `changed-preview-frame.png`, `keyframe-preview.mp4`, and `keyframe-preview.png`. Independent failure/cancellation review is recorded in [INDEPENDENT_REVIEW.md](INDEPENDENT_REVIEW.md).

The independent review additionally decoded a 9,810-byte, 160 × 100, ten-frame preview; verified source pause and result reuse; rejected an impossible 1,024-byte request without replaying the previous artifact; and reopened/cancelled the specific real queued preview after an edit made it stale. Its isolated test deliberately stopped its own queue to hold that job pending. Evidence: `test-output/review/rendered-preview-8qiQH0/evidence.json`. No page errors occurred. The stale-modal access issue found in review was fixed and retested. This was not a new browser role-matrix audit; the feature continues through existing authenticated policy-enforced export endpoints.

## Windows package

The existing Windows package's five web files were refreshed and hash-verified; its backend is unchanged. `test-output/browser/rendered-preview-package.json` and both package provenance manifests record current asset/source hashes. The actual packaged desktop test passed at 16:40:20 UTC in **9.33 seconds**, including rendering/playing through Preview video, region controls, restricted PATH, sandbox isolation, native clipboard, Save As identity, bundled validation and service shutdown. Evidence: `test-output/native/desktop-AeCogT/evidence.json`.

Save current work and reopen the application to load the new interface. The preserved Linux archive has not been refreshed. The earlier broad-suite totals remain historical; this change was verified with the relevant browser, desktop, build/type and independent checks.
