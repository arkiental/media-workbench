# Region sidebar (layout B)

Subsequent update: **Preview video** now renders/plays the actual export; the original source-inspection action is renamed **Play source region**. See [RENDERED_PREVIEW_EVIDENCE.md](RENDERED_PREVIEW_EVIDENCE.md) for the newer 31-check browser and Windows desktop evidence. The initial layout results below remain historical.

Implemented and verified on Windows on 12 September 2026. The existing editor now places playback on the left and a selectable region list on the right, with the shared source timeline and selected-region Start/End controls below. The backend and media engine remain independent of this presentation component.

## Behavior and paths

- `apps/web/src/CutWorkspace.tsx`: region selection, actual video transport, source frame/keyframe stepping, thumbnails/waveform timeline, Start/End buttons and I/O shortcuts, committed numeric bounds, region preview, add/remove, and undo/redo integration.
- `apps/web/src/main.tsx`: persisted recipe/project/export integration and an export-plan revision guard. A late plan response cannot restore export authority after a region or option changes.
- `apps/web/src/styles.css`: neutral desktop layout and responsive sidebar stacking. The browser test checks a 390-pixel viewport for page overflow.
- `tests/browser.smoke.ts` and `tests/native-desktop.test.ts`: real browser/media and packaged desktop evidence.

Selecting a region preserves the playhead. Setting a boundary changes only that region. Invalid or equal bounds are rejected before recipe mutation. New regions initially span the current position to source end, with explicit feedback explaining how to shorten them. All changes remain non-destructive. Region preview uses actual source/proxy video, starts at the selected in-point, and pauses at its out-point. This source preview does not claim to simulate stream-copy boundary shifts or rendered export filters.

Indexed seeks discard outdated responses. Original/proxy switching preserves source time. Seeking, selection, recipe changes and undo/redo cancel bounded playback. Shortcuts ignore editable fields and modifiers. Overlapping kept regions remain individually selectable on separate timeline lanes and export in recipe order.

## Verification

`npm run build` and final `npm run typecheck` passed. The updated `npm run test:ui` passed **27 checks**, with no page errors, at 16:06:28 UTC. It exercised actual download/import/playback, selected-region edits and shortcuts, invalid bounds, exact-frame inspection, preview stopping, real proxy switching, add/remove/undo/redo, mobile layout, persistence and advanced export.

The exported recipe contains source regions `[0.5, 0.8)` and `[1.0, 1.5)`. Its downloaded H.264/AAC output is **14,019 bytes**, **160 × 100**, **0.8 seconds**, below the **30,000-byte maximum**. FFmpeg fully decoded **eight frames**. The extracted frame visibly contains the requested text and caption. Desktop/mobile screenshots and this rendered frame were inspected.

Evidence: `test-output/browser/evidence.json`, `region-sidebar.png`, `region-sidebar-mobile.png`, `ui-export.mp4`, and `region-export-frame.png`.

The independent reviewer verified selection/cursor separation, selected-only marks, rejected bounds, actual preview pause at 1.5 seconds, reordered responses from real indexed seeks, shortcut isolation, and undo/redo. It reproduced a stale export-plan race in the prior UI, then verified the revision guard discards the delayed response and keeps export disabled. Evidence: `test-output/review/layout-b-oCPDMM` (failure) and `test-output/review/layout-b-uTQc18/evidence.json` (fixed). See [independent review](INDEPENDENT_REVIEW.md).

## Packaged application

The existing Windows package's five `dist/web` files were refreshed and hash-checked against the source build; its backend hash is unchanged. `package-provenance.json` records `uiRefresh`, built assets and source hashes. Evidence: `test-output/browser/windows-ui-package.json`.

The updated package passed the native suite in **7.05 seconds**, including visible region controls, setting a real start boundary, restricted-PATH startup, sandbox/context isolation, actual file clipboard, Save As byte identity, bundled media validation and owned-service shutdown. Evidence: `test-output/native/desktop-TaM0Xb/evidence.json`. An initial launch was correctly refused by the single-instance lock because the user's application was already open. The successful test used a separate Chromium user-data directory and separate service data; the user's running instance was not closed.

Save any current editing work and reopen the application to load the refreshed interface. Linux's preserved archive has not been refreshed and does not contain this UI change; its existing environment blocker remains documented in [Linux package evidence](LINUX_PACKAGE_EVIDENCE.md). The earlier broad-suite totals are historical; this UI follow-up reran the relevant browser, desktop and build/type checks.
