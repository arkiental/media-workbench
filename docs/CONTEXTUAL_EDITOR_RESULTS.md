# Contextual editor implementation

Implemented 2026-09-18 from the approved concept 02 image. The app portion is implemented; the presentation title, numbered callouts, and explanatory footer are intentionally excluded from the product UI.

## Changes

- Dark editor shell with 61px header, a vertical Media / Text / Audio / Transform tool rail, a large viewer, right inspector, and a 211px Text / Video / Audio timeline.
- Selecting a title on the canvas or timeline opens its inspector. Text content, font, size, color, alignment, source timing, and position persist in drafts, projects, and undo history. Canvas titles can be moved, resized, and nudged using arrow keys; Shift increases the nudge distance.
- Playfair Display Bold is bundled with its OFL license and used in both browser overlays and real FFmpeg exports. Existing unstyled recipes retain their legacy appearance.
- Advanced caption/timing settings stay collapsed. Cut and Project are available through the tool rail's More menu. Frame stepping, playback volume, mute, and Render preview are available through the viewer's More menu.
- Automatic waveform analysis covers the entire source in cancellable windows; the waveform uses a peak-normalized visual amplitude without altering audio volume.
- Cut-region selection overlays the video track. Existing trim, proxy, export-plan, rendered-preview, and media-library workflows remain available.
- Fill crops the viewer to its available viewport; Fit retains the full source frame. The selected mode is saved with the workspace.

## Independent critic

Two visual review passes compared actual screenshots with the approved reference. Corrections addressed rail spacing, inspector column widths, the Advanced row, title weight and bounds, timeline label typography, and resize-handle direction. Final review accepted the main geometry and visual styling as closely matching the reference. A duplicated transform-preview notice found in the final review was removed.

This is not a claim of pixel identity. The reference is a generated design illustration. The real source has different frames, a burned-in title at 4.135 seconds, real 24fps metadata, and a different audio waveform. The clean final screenshot uses the real source at 7 seconds. Text rendering may also differ slightly between the browser and FFmpeg.

## Validation

- `npm run build`: passed.
- `npm test`: 93 tests, 78 passed, 15 platform/opt-in skips, zero failures.
- `npm run test:ui`: all 34 browser workflow checks passed, including import, playback, source-frame stepping, trim undo/redo, proxy switching, draft recovery, transformed export under a strict size limit, decoded frame identity, rendered preview invalidation/reuse, projects, and media deletion isolation.
- `npx tsx scripts/check-contextual-editor.ts <source-video>`: selection, content and style persistence, canvas dragging, outward corner resizing, center-in-frame reset, and mobile overflow checks passed. Use a source longer than 7 seconds for the visual reference state.
- `tests/text-style.test.ts`: real decoded export pixels verify font rendering, color, size, alignment, position, and intentional clipping at frame edges. Style metadata survives split/reordered source-time cuts; invalid filter-like colors are rejected.

Evidence is under `test-output/contextual-editor` and `test-output/browser`. Pre-change source backups are under `output/editor-contextual-backup` because this workspace has no Git metadata.

## Preview behavior

Interactive titles are composited over source playback. Crop, rotation, and resize require Render preview to inspect their final combination with titles; the source viewer explicitly labels this state. Titles placed at frame edges may be intentionally clipped in both canvas and export. The fourth alignment-row action centers the title in the frame; its tooltip and accessible name describe that behavior.

The local browser service at http://127.0.0.1:4319 was restarted with the new backend after confirming it had no active jobs. Existing standalone desktop release binaries have not been rebuilt.
