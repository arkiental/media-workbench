# Mobile editor review record — 0.2.7

The requested collaboration used Claude Opus 5.5 through T3 delegated tasks for planning and independent review; Codex implemented the changes.

## Plan and review responses

Opus identified the initial open inspector, duplicated bottom navigation, excessive timeline tool rows and missing touch navigation as the main obstacles. The implementation puts preview and timeline on one screen, moves tools into dismissible sheets, and adds anchored zoom and a full-source navigator.

The first review approved the direction with interaction fixes. Responses:

| Finding | Resolution |
| --- | --- |
| Per-keystroke time entry seeks to zero and shows float noise | Local draft text, three decimals, validation, Enter/blur commit and Escape restore |
| Lower populated lanes inaccessible by touch | Vertical touch panning and landscape regression check |
| Native overview slider competes with pointer handler | One pointer handler, touch-action on wrapper, keyboard-accessible native range |
| Gesture suppresses the next intentional tap | Suppression consumed once and cleared on a new touch gesture |
| Playback follow fights manual panning | Following suspended briefly during manual navigation |
| Split acts on an unrelated selected section | Compact Split uses the section under the playhead |
| Custom ruler lacks slider keys | Arrow/frame steps, Home/End and Page keys |
| Viewport state updates on every desktop scroll | Compact-only updates batched by animation frame |
| Cancelled trim leaves the playhead moved | Restore the pre-drag position without committing |
| Escape closes the sheet before playback options | Close playback options first |
| Old landscape sizing conflicts with compact layout | Remove superseded layout rules |

The second review found no release-blocking source issue and made approval conditional on current mobile/browser checks and real portable verification. It also requested that an untouched focused time field not rewind playback, and that notifications not obscure landscape timeline controls. The field now tracks whether it was edited; landscape notices stay over the preview with a Dismiss action. Closing a compact tool sheet hides its preview manipulation handles.

The final browser validation checks identical export recipes and settings, complete decoded frame count, frame order and pixel agreement. Independent multithreaded lossy encodes can differ slightly: the investigated exports used the same software encoder, settings and source, with per-frame RGB mean error below 1.08/255. Stream-copy frame checks remain exact. The forced-crash test now confirms every captured owned process has exited before accepting a Windows taskkill race.

## Accepted scope and limits

Swiping pans the timeline; ruler dragging seeks. This keeps navigation from accidentally changing the preview time. Explicit controls replace long-press and swipe-to-dismiss gestures. Zoom retains the existing 1–20× draft range. No inertia or haptics are claimed.

Opus reviewed source and ran typechecking; Codex ran the browser, media and portable checks. Browser touch checks use CDP on Chromium with synthetic fixtures. Physical iOS/Android and Safari verification remain outside the evidence. Release notes record the completed validation and the portable's source commit and checksum.
