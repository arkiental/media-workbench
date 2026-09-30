# Media Workbench UI implementation plan

Based on the 18 September 2026 UI audit. Goal: a dependable single-source media workspace with an obvious import → edit → export flow.

## First implementation release

1. **Draft continuity.** Versioned, user/source-scoped local drafts; preserve recipe history, export settings, playhead, region selection and project identity across screen navigation/reload. Restore the last available source; validate persisted data; report storage failures. Named projects remain explicit server saves and pin their media. Browser drafts do not pin files or replace project saves.
2. **Workspace and appearance.** Library / Editor / Jobs navigation; Add media action; settings subnavigation for presets/integrations/admin; System/Light/Graphite appearance persisted locally. Editor toolbar, compact viewer/timeline and contextual Transform/Text/Audio/Source/Project panels. Export in a dedicated dismissible panel. Preserve existing processing controls and planner validation.
3. **Recognition and navigation.** Saved projects in Library, search and media-type filters, meaningful job names, scoped success feedback, actionable editor empty state. Preserve all native artifact actions and permission checks.
4. **Validation.** Typecheck/build, draft unit tests and browser regression tests. Exercise actual trim/export/rendered preview; navigate away/reload with edits; load saved projects; inspect light/dark, 1366 × 768, 1440 × 900 and narrow layouts. Capture screenshots and record limitations.

## Next release: direct manipulation and export refinement

- Accessible timeline region drag handles with keyboard/numeric alternatives, undo grouping and frame snapping.
- Crop overlay with source-pixel coordinates, aspect-ratio lock and resize controls; verify rotation/order and portrait media.
- Preset creation/editing forms; named built-in goals; advanced JSON import/export retained.
- Recipe/options revision keys for reusable validated render results; distinguish temporary preview artifacts from intentional exports, including persistence and retention semantics.
- Optional short-range render previews with clear differences from full output, resource limits and cancellation.
- Automatic export-plan preparation with stale-response protection and explicit review of changed cut boundaries/fallbacks.
- Expanded queue filters, asset thumbnails with bounded loading/cache, inline actionable failure recovery and sensible multi-file import routing.

## Release gates

- Leaving Editor for Jobs cannot change the active edit. Reload restores the current user's last draft when its media still exists.
- Unavailable/corrupt local storage cannot crash the app or falsely report a durable draft save.
- Named project load and source draft resume are distinguishable; no silent overwrite of another project's recipe.
- At normal desktop sizes the viewer, timeline, boundaries and Export entry point are visible together; long inspectors/results scroll independently. Small screens reflow without horizontal page overflow.
- Source playback is explicitly labeled; rendering and export remain real server operations. Validation/copy-cut warnings and existing access restrictions remain intact.
- Main actions are keyboard accessible, themed focus and text remain legible, and dialogs return focus to their trigger.

## Status

First implementation release delivered in source and the rebuilt browser bundle. See [actual results, screenshots and limits](UI_IMPLEMENTATION_RESULTS.md). The next-release items above remain open; desktop package refresh and broader accessibility/platform verification remain separate work.
