# Mobile video editor

The compact editor opens on the preview and timeline. Cut, Text, Overlay, Audio and Transform share one bottom tool rail. Tap a tool to open its sheet; Done or a second tap returns to the timeline. Library and Export remain in the header. Empty caption and overlay lanes stay hidden.

- Drag the ruler to seek. Swipe the tracks to pan without changing the playhead or edit. Vertical swipes reveal lower lanes when space is limited.
- Pinch or use the zoom buttons for detail. Zoom keeps the visible playhead or viewport center anchored. Fit shows the whole source.
- Drag the overview strip to travel across a long source. Show playhead returns the detailed timeline to the current time.
- Playback follows the playhead, with a short pause in following while you pan manually.
- Split acts on the section under the playhead. Undo remains directly available; More contains Redo, snap, section navigation and precise playhead entry.
- Trim handles use finger movement from the starting point. Cancelling a drag restores the playhead and leaves the edit unchanged. Very short sections stack their two handles so each remains accessible.
- Enter a time in the Cut sheet or More menu and commit with Enter or by leaving the field. Escape restores the previous value. Frame-step buttons remain beside Play.

Compact layout applies through 850 CSS pixels wide, and through 1000 pixels wide on screens at most 500 pixels tall. Short landscape screens place preview and timeline side by side. Insets account for device safe areas.

## Verification

Run `npm run build`, `npm run test:mobile`, `npm run test:responsive` and `npm run test:ui`. The mobile suite uses Chromium touch input through CDP with generated media, asserting layout at 320–932 pixels wide, ruler/overview seeking, panning, pinch zoom, precise entry, split/undo, trim cancellation and populated landscape lane scrolling. Responsive checks cover desktop and compact controls, contrast, captions, transforms and real exports. The general browser suite checks edited output frames and saved project recovery.

`npm test` covers contracts, media processing, permissions and recovery. The Windows portable smoke test extracts the release with a restricted PATH, downloads and verifies its pinned tools, starts the actual Electron app, checks compact 800×600 editing, validates an exact export against source frames, and relaunches with preserved data.

These are automated browser and Windows native checks, not physical iPhone/Android or Safari testing. Touch panning is direct; there is no inertial fling. Zoom remains bounded at 20× to preserve the existing draft format.
