# UI implementation: first release

18 September 2026. Implements the first release in [the plan](UI_IMPLEMENTATION_PLAN.md). The source browser application has been rebuilt. Existing packaged desktop/Linux artifacts have not been refreshed by this UI change.

## Delivered

- **Draft continuity:** per-user/source/project local drafts preserve recipe history (up to 100 snapshots), export options, project name/identity, selected region, timeline zoom/snap and playhead. Drafts restore after navigation/reload on the same browser origin. Corrupt drafts are rejected. Storage failures retain a session copy and show an honest warning. Incomplete fields do not replace the last valid draft; invalid intermediate undo snapshots cannot erase a later valid recipe.
- **Shell:** Library / Editor / Jobs; global Add media; Presets, Integrations and owner-only Administration under Settings. Navigation clears unrelated transient feedback. Empty Editor provides direct actions.
- **Appearance:** system/light/graphite preference, neutral theme tokens, focused/selected/action/error states and responsive layout.
- **Editor:** compact viewer/timeline, contextual Cut / Transform / Text / Audio / Source / Project tools, one source transport with frame stepping, mute, volume and fullscreen. Keyframe controls remain under Frame inspection and playback. Intentional playback interruptions no longer produce a spurious play/pause error.
- **Export:** prominent Export action opens a native modal with a simple output goal and MB input, existing portable presets, advanced encoding controls and the real reviewed plan. Source playback is explicitly distinguished from Render preview. Completed export players are collapsed by default.
- **Library/jobs:** source/export/proxy filters, filename search, type/date metadata, saved projects in Library, meaningful job/source names. Existing download/native/deletion/permissions behavior remains wired to the original APIs.

## Verified evidence

`npm run build` passed (includes TypeScript checking). Four draft tests passed. The updated `npm run test:ui` passed **34 real-browser checks**, with no uncaught browser errors. It covers:

- real yt-dlp inspection and selected-item download against a local deterministic fixture;
- real imported playback, indexed frame stepping, region selection, boundaries and undo/redo;
- active second-region preservation through navigation;
- trim bounds, playhead, zoom and undo history across navigation and page reload;
- proxy playback and original-source timing;
- crop, rotate, resize, text, captions, audio changes and removed intervals;
- a complete **14,019-byte**, **160 × 100**, **eight-frame** export under a **30,000-byte** limit;
- rendered-preview decoded-frame equality, stale-edit invalidation, repeat-preview reuse within the mounted editor, and real keyframe-copy preview;
- named project and theme restoration;
- both trim fields and region-playback controls visible at **1366 × 768**;
- **390 px** layout without horizontal document overflow;
- library/settings/integrations/admin reads and independent media/history deletion semantics.

[Machine-readable browser evidence](ui-implementation/browser-evidence.json).

The final broad `npm test` run passed: **91 tests total, 76 passed, 0 failed, 15 explicitly skipped**, in 186.82 seconds. Skips include opt-in native/live-site/Docker and platform-specific cases; they are not claimed as verified. This broad run includes the four draft regressions and real media, workflow, authorization, retention, transfer and cancellation tests. Dependencies were unchanged, so the existing installed lockfile environment was used rather than a fresh installation.

Representative palette calculations: light text 15.43:1, light secondary 5.78:1, light primary label 6.65:1; graphite text 13.82:1, graphite secondary 6.89:1, graphite primary label 7.76:1. These sampled token pairs are not a complete accessibility audit.

## Screenshots

All use generated test media, not personal footage.

- [Light workspace, 1366 × 768](ui-implementation/screenshots/workspace-light-laptop.png)
- [Graphite workspace, 1440 × 900](ui-implementation/screenshots/workspace-graphite.png)
- [Contextual transform inspector](ui-implementation/screenshots/workspace-transform.png)
- [Reviewed export panel](ui-implementation/screenshots/workspace-export.png)
- [Narrow editor](ui-implementation/screenshots/region-sidebar-mobile.png)

## Limits and next work

Browser drafts are tied to the browser profile/origin and do not pin their media; save a named server project for durable media dependencies. An Electron service that changes origin between launches does not get cross-launch localStorage persistence from this change. Existing desktop binaries still contain their prior UI until rebuilt/packaged.

This is a working first release, not completion of the entire design roadmap. Region drag handles, visual crop tools, preset editing forms, thumbnail caching, short preview ranges, and reusable preview/export artifacts across navigation remain in the next-release plan. Preview artifacts still appear in Library as exports. Export-plan preparation remains an explicit review step. Native integrations, Linux desktop, physical GPU rendering and live sites were not revalidated in this UI pass. The full set of zoom, screen-reader, long-queue and touch editing scenarios remains to be tested.

## Requirement mapping

This UI work primarily addresses S06/S12 and A09/A10/A11/A12/A21. Media commands, service contracts, preset schemas and security boundaries are unchanged. The real-browser output assertions provide regression evidence for the existing media behavior; they do not replace platform-specific release gates.
