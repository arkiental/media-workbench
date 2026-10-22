# Editing reliability and recovery update

This update connects common media workflows through clearer feedback, useful Undo history and durable desktop drafts. It retains the local-first service/Electron architecture and existing source identity.

## User-visible changes

- Multi-file imports show per-file progress, results, cancellation and retry. Temporary file-import preview-capacity errors use bounded automatic waiting; invalid media remains a visible failure.
- Library and Editor expose compatible-copy recovery at playback failure. Copy creation, retry and switching preserve edits/playhead. Library filters, sorting, preview navigation and item-anchored return scrolling retain context.
- Named projects can be updated or saved as copies. Saved projects support source-aware search/context. Export settings can be saved as named presets directly from the dialog.
- Export review/progress supports duplicate-submit protection, cancellation, retry, completion preview/download, meaningful filenames and reload/restart reconnection to persisted jobs.
- Desktop drafts use atomic storage with stale-write protection and retain multi-section edits across full restart. Compact layout, touch seeking after panning, connection feedback, thumbnail recovery and Save As outcomes have focused fixes.
- Crop/resize input commits complete values once. Trim and overlay canvas gestures discard cancelled/stale work. Audio and overlay sliders use one Undo step per completed gesture; captions group typing while retaining live preview and draft saving.
- Explicit section and boundary navigation reveals offscreen targets at high zoom. Native playback and text-entry focus retain their own controls.

Temporary overlay-slider values are preview-only until the gesture completes. Cancelled or unfinished gestures are discarded. Completed edits and their history are durable and match exported output.

## Verification

The local Windows validation used generated disposable media and isolated service/profile directories:

| Check | Result |
| --- | --- |
| TypeScript, production build and whitespace checks | Passed |
| Relevant unit/API/draft/transform/caption/overlay/native-helper/export checks | 27 passed; one optional Windows clipboard test skipped |
| Complete `npm test` suite with local tools installed | 218 passed, zero failed, 16 skipped |
| Affected and cumulative browser suites | 30 passed |
| Source-native Electron checks | 37 passed across seven suites |
| Clean extraction of the local portable ZIP | Nine checks passed |
| Final revised exact packaged executable | 38 native checks passed across seven suites; zero page errors |

Browser checks cover repeated/interrupted gestures, cancellation, keyboard behavior, source isolation, Back/Forward, failure/retry and mobile emulation. Native checks include immediate quit after completing an edit, exact recipe/history restoration, actual exports and decoded output pixels. Clean extraction checks verified tool setup, offline reuse, compact editing, intended source frames/audio, service shutdown and offline relaunch.

Precommit review reproduced and corrected one additional interaction: after cancelling an overlay slider, Escape must still close a subsequently opened Export or Project dialog. The cancellation marker still rejects stale input events but no longer intercepts unrelated keyboard input. All 15 slider checks, nine source-native overlay checks, and the affected canvas/overlay/project/export/mobile browser suites passed. A fixture setup wait retains its strict upload-status assertion while allowing navigation preview requests to finish. The complete suite initially failed because a test expects downloader binaries under `.tools`; installing those ignored local tools resolved it without changing the test or application behavior.

The final revised ZIP also passed all nine clean-extraction checks. The full-suite skips are platform-dependent Docker/Linux, opt-in live-provider and optional native integration checks. Separate native acceptance covers the desktop editing workflows listed here; it does not turn unavailable platform/provider coverage into passes.

Run source checks with the tools configured for the target machine:

```sh
npm ci
npm run tools:setup
npm run build
npm test
npx tsx tests/overlay-cancel.smoke.ts
npx tsx tests/overlay-sliders.smoke.ts
npx tsx tests/overlay.smoke.ts
npx tsx tests/caption-history.smoke.ts
npx tsx tests/section-navigation.smoke.ts
```

The other focused browser regressions are in `tests/*.smoke.ts`. Native suites include `overlay-reliability-desktop`, `navigation-caption-desktop`, `precision-editing-desktop`, `audio-editing-desktop`, `saved-workflows-desktop`, `parallel-desktop` and `desktop-workflows`. They accept `MW_TEST_ELECTRON` for a source shell and `MW_TEST_PACKAGED_APP` for the exact packaged executable. Generated evidence belongs in ignored `test-output/`, never in source commits.

Build a portable archive with `npm run package:portable`. `MW_PACKAGE_OUTPUT` selects a distinct output directory. See [Windows portable instructions](WINDOWS_PORTABLE.md) for setup, licensing and data backup. The validated local ZIP was not published by this source update.

## Known limits

- Adding an overlay immediately while thumbnail/waveform preview work fills both processing slots can show an explicit busy error. Wait for preview work to finish before adding it again. This is separate from the automatic capacity recovery for ordinary file imports.
- Touch checks use Chromium emulation; physical phones/iOS remain unverified. Manual native chooser/clipboard/drag-out, physical audio output and broad codec/GPU/device coverage also need hands-on acceptance. Automated Save As checks use real IPC/file copying with supplied chooser responses.
- First portable setup requires internet; the Windows build is unsigned. Permanent browser denial of AudioContext resume can still leave playback silent.
- Earlier isolated export-dialog and missing-fixture incidents remain inconclusive because the original assertion/response was not retained. Bounded diagnostic repetitions passed, and tests now retain status/body/timing/trace evidence. They are not represented as proven product fixes.
- The legacy caption/download-quality test was corrected after proving that inspection succeeded but the test awaited removed controls. Quality/item/provider-payload, mobile, caption and decoded-export assertions remain. A later raw fixture upload returned an explicit capacity 429; its test now uses the real Import queue.

No deployment, release upload, installed-app replacement or network/access-setting change is part of this source update.
