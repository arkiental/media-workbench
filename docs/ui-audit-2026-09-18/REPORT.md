# Media Workbench: UI and UX audit

18 September 2026. Recommendation: a restrained media workspace with a persistent viewer, timeline, contextual inspector and clearly separated export flow. Use neutral graphite for an optional editing theme, plus an equally complete light/system theme. Fix editing continuity before applying visual polish.

## Scope and evidence

Inspected the current React implementation and rebuilt its browser bundle. Ran an isolated local service with generated four-second media at 1440 × 900 and 390 × 844. Captured 13 screenshots, imported media, changed a region to 0.5–1.5 seconds, resolved a size-limited export, completed the export, played its rendered preview and saved a project. The UI reported a validated 14.3 kB, one-second output. This was an expert walkthrough, not a user study or comprehensive regression/accessibility test.

The screenshots show the current browser UI, not the packaged Electron window. No Media Workbench desktop window was open. Native file clipboard, executable handoffs, cookie import, shared hosting and live-provider downloads were inspected in code/documentation but not exercised in this audit. No user library or application source was changed. The isolated audit service was closed afterward.

- [Screenshot gallery](gallery.html)
- [Raw observations and dimensions](evidence.json)
- Reproduction: `node scripts/build.mjs`, then `node --import tsx scripts/capture-ui-audit.ts` from the repository root. Requires the existing generated fixture, staged tools and Edge. Each run creates a separate test data directory.

## What the application does

| Area | Existing capabilities | Audit evidence |
|---|---|---|
| Acquire media | File picker and drop zone; managed copies; multiple URLs; duplicate URL removal; compatible/original/audio preferences; inspect formats and select an item within a post; optional credentials | Import exercised; URL and credential features inspected in code |
| Cut | Source playback; frame/keyframe stepping; frame inspection; zoom; region selection and in/out fields; I/O shortcuts; multiple kept regions; remove interval; undo/redo; thumbnails and optional waveform | Basic trim exercised; additional controls inspected |
| Transform | Source-pixel crop, rotation and resize | Controls/code inspected |
| Text | Timed text; SRT/WebVTT import; caption editing; burned/soft subtitles; source-time caption export | Controls/code inspected |
| Audio | Track selection, mute, replace/mix another source, volume, fades and normalization | Controls/code inspected |
| Export | Automatic/copy/exact cutting; quality, bitrate or strict size modes; H.264/HEVC/AV1; MP4/MKV; software/hardware preference; speed; frame rate; plan explanations; validated rendered preview | Exact size-limited flow and preview exercised; other modes not retested |
| Jobs | Persistent history, stage/progress, cancellation, retry, queued-job ordering, batch handling, JSON/CSV results | Completed jobs observed; mutations not exercised |
| Library | Original/download/export/proxy artifacts; preview, download, source editing, metadata, managed deletion | Imported source and completed exports observed |
| Projects/presets | Save/load recipes with source dependencies; portable preset validation/import/export; JSON editing | Project save exercised; other features inspected |
| Desktop integrations | Native copy-file/copy-path, reveal and configured external actions including ShareX | Code/documentation only; browser explicitly reports limitations |
| Operations | Concurrency, tool and encoder diagnostics, support data, users/policy, API pairing, retention | Screens inspected; settings left unchanged |

The useful product promise is **get media, keep the moments you want, and produce a dependable file for sharing**. A single-source editing tool fits the current model. A full multitrack editor would introduce expectations and scope the application does not currently meet.

## Findings, in priority order

| Priority | Evidence | User consequence | Proposed change |
|---|---|---|---|
| P0 | Set start to 0.7 s → Queue → Editor → start becomes 0. `evidence.json` records this. Editor state is local to a conditionally mounted component. | Checking job progress discards the active edit. Saving a project does not automatically reconnect it when returning from another tab. | Keep a project/draft store above screen navigation; autosave drafts; restore selection/playhead/options; show save status and recoverable drafts. Test unsaved and saved/reloaded projects separately. |
| P1 | Initial editor is 2,804 px tall at a 900 px viewport. In/out controls are below the initial fold; export sits much farther down. [Editor](screenshots/04-editor-full.png) | The user repeatedly leaves the picture to change settings and cannot keep the main task in view. | Persistent viewer and timeline, compact transport and adjacent region fields; inspector sections for Transform, Text, Audio; Export in the project toolbar. |
| P1 | Native player transport plus separate Play, frame/keyframe controls and a separate scrubber. [Viewport](screenshots/03-editor-viewport.png) | Several controls represent the same playback state; scanning and coordination are harder. | One synchronized transport; keyboard-accessible stepping; frame precision available without a second prominent playback interface. |
| P1 | Presets starts with a large JSON textarea; saved projects share that page. [Presets](screenshots/09-presets.png) | Finding prior work and making a reusable export setting both require understanding internal organization. | Projects under Library; named export presets with editable forms; JSON under Import/Export advanced actions. |
| P1 | Numerous codec/encoder/byte/attempt choices precede two similarly styled plan/export buttons. [Export](screenshots/05-export-plan.png) | Export requires technical decisions before the user can judge the result. | Preset + quality/size goal + filename/destination first. Automatically prepare a plan, then show a concise review with material warnings. Keep expert controls available. |
| P1 | Original monitor does not render all effects; Preview video performs a full export and creates another `clip.mp4`. [Preview](screenshots/06-rendered-preview.png), [Library](screenshots/08-library.png) | Users can mistake source playback for the final result, and previews look like deliberate exports. | Explicit Original / Rendered result states. Label action “Render preview”; communicate cost/progress/cancel. Cache by recipe and options; reuse matching validated artifacts across preview/export; identify temporary previews separately. |
| P2 | Eight peer navigation buttons include Administration alongside Input and Editor. [Import](screenshots/01-import.png) | Administrative structure competes with the everyday workflow. | Three main destinations: Library, current Editor, Jobs. Global Add media action. Put Integrations, Presets management and owner-only Administration under Settings. |
| P2 | Library shows text cards without persistent thumbnails or search; two same-named exports are indistinguishable. | Difficult to recognize assets and relate outputs to their source/project. | Thumbnail list/grid, search, Sources/Exports/Projects filters, human names, source relationship, date, duration and dimensions. Hide technical metadata until requested. |
| P2 | Queue foregrounds `export` and opaque IDs, with deletion as a prominent peer action. [Queue](screenshots/07-queue.png) | Users cannot quickly identify the file or the next useful step. | File/project names, thumbnail, stage text and actionable failure recovery; Open result first; history deletion in overflow. Separate active work from history. |
| P2 | A project-saved notice persists when moving to Queue and Library. | Feedback is detached from the task it describes. | Save status next to project name; transient success notices; persistent inline failures where action is needed. |
| P2 | Editor reflows without horizontal overflow at 390 px, but reaches 5,358 px in the captured state. | Responsive CSS does not by itself make editing practical on a phone. | Preserve preview and active controls; use tool drawers/sections; keep Jobs/import useful at small widths; validate touch trimming separately. |

Strengths to retain: real validated exports; immutable managed originals; explicit copy-versus-encode planning; frame-aware trimming; source-time recipe semantics; cancel/retry mechanisms; labeled form controls; visible keyboard focus styling; distinction between deleting history and deleting media. These are valuable foundations.

## What the research suggests

These principles inform the redesign; they do not prove a particular palette is best.

1. **Keep users oriented and protect their work.** Show current selection, draft/save state, source versus rendered result, and job stage. Give recovery actions in plain language. This applies NN/g's system-status, user-control and recognition heuristics. [NN/g: usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/)
2. **Use progressive disclosure.** Keep frequent trimming and export choices visible; put encoder details, command bindings and raw metadata behind descriptive controls. Hiding every control behind icons would defeat this purpose. [NN/g: progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/)
3. **Organize navigation around the user's tasks.** The main destinations should have clear hierarchy; project tools belong inside a project workspace. [Microsoft: navigation design basics](https://learn.microsoft.com/en-us/windows/apps/design/basics/navigation-basics)
4. **Make the visual system measurable.** Target WCAG AA text contrast of 4.5:1 for ordinary text and 3:1 for qualifying large text. Interactive targets should meet the 24 × 24 CSS px minimum or its spacing/exceptions; prefer roughly 40–44 px touch controls. These are separate from a full accessibility conformance claim. [W3C: contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html), [W3C: target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)

### Product references worth borrowing from

| Reference | Relevant pattern | How to use it here | Boundary |
|---|---|---|---|
| [LosslessCut](https://losslesscut.app/) | Timeline, detailed segment panel, frame/keyframe navigation and segment autosave | Closest functional reference for quick single-source cutting | Explain exact re-encode versus keyframe cuts; do not imply every edit is lossless |
| [HandBrake presets](https://handbrake.fr/docs/en/latest/workflow/select-preset.html) | Choose a settings bundle by intended playback use | Offer “Compatible MP4,” “Smaller file,” and a configurable size limit | Do not hard-code third-party sharing limits as timeless facts |
| [HandBrake preview](https://handbrake.fr/docs/en/latest/workflow/preview-settings.html) | Render a sample to judge output before the complete encode | Future short-range preview, explicitly distinct from a full final export | Requires rendering work; current app renders the full edited result |
| [DaVinci Resolve Edit](https://www.blackmagicdesign.com/products/davinciresolve/edit) | Media viewer, timeline, inspector and task-specific workspace organization | Borrow stable spatial relationships and subdued chrome | Avoid copying multitrack complexity, tiny controls and the entire professional suite |
| [Shotcut screenshots](https://www.shotcut.org/screenshots/) | Alternative arrangements of a media-editing workspace | Secondary reference for panel placement | Panel customizability is optional, not a first-release requirement |

These are pattern references, not endorsements to reproduce their interfaces. Research accessed 18 September 2026; the HandBrake “latest” pages describe its development documentation.

## Visual direction comparison

| Direction | Character | Fit and tradeoff | Decision |
|---|---|---|---|
| Neutral studio | Graphite surfaces, restrained blue selection, fine dividers, compact toolbar and timeline | Strong fit for sustained media editing; must avoid low-contrast gray-on-gray and excessively small tools | Recommended editing appearance |
| Light desktop utility | Off-white canvas, white panels, dark ink, blue actions, familiar system type | Strong for import, library, settings and bright rooms; the source monitor should retain a neutral dark surround | Ship as a first-class light/system option |
| Warm editorial | Warm whites, ink, muted earthy accent, more spacious typography | Could suit media cataloguing, but warmer chrome and editorial spacing contribute little to precise trimming | Do not lead with it |

My recommendation is a shared **neutral utility design system** with light and graphite appearances, not two different layouts. Dark mode is an aesthetic/work-context choice here, not a proven universal usability improvement. Let the user choose and persist the preference.

### Proposed starting tokens

| Token | Graphite | Light |
|---|---|---|
| Canvas | `#181A1D` | `#F4F5F6` |
| Panel | `#22252A` | `#FFFFFF` |
| Raised/control | `#2B2F35` | `#ECEFF2` |
| Main text | `#F1F3F5` | `#20252B` |
| Secondary text | `#B4BAC3` | `#59636F` |
| Decorative divider | `#3C424B` | `#D8DDE3` |
| Accent/action fill | `#8DB8F5` with dark label | `#245CA6` with white label |

These are candidates, not a completed accessible token system: validate every actual text, icon, control boundary, focus and selected-state pairing. Subtle decorative dividers are not sufficient interactive boundaries.

Use Segoe UI/system sans for UI, tabular figures for timecodes, and monospace only for technical details. Aim for 14 px standard controls, 12–13 px secondary labels and 18–20 px section titles. Use a 4/8 px spacing scale, 4–6 px corner radii, restrained borders and shadow only when it explains an overlay. Make primary, secondary, destructive, disabled, focused, busy and selected states distinct.

### Avoiding the generic “AI slop” result

- Let real footage, thumbnails, waveforms and meaningful selection states provide visual interest.
- Use a stable editing workspace instead of a dashboard of oversized cards, invented statistics or welcoming slogans.
- Avoid decorative gradients, glowing borders, glass panels, gratuitous purple, large pill buttons and unnecessary animation. None of these is inherently bad; they have no clear role in this product.
- Give regions, filenames, timings and export decisions a deliberate hierarchy. More whitespace alone will not fix an unclear workflow.
- Use one coherent icon family with accessible names and visible labels for important actions. Do not compress every action into an unexplained icon.
- Write for the task: “Add media,” “Start,” “End,” “Render preview,” “Export,” “Show in folder.” Keep “decoded presentation timestamps” and similar diagnostics in technical details.

## Proposed functional layout and journeys

**Shell:** Library / Editor / Jobs in a compact navigation area; Add media available globally; Settings separated. Project toolbar: name, save state, Undo/Redo and Export. No empty Editor dead-end: show Add media and Open project actions.

**Editor:** viewer occupies the main area; kept regions and contextual tools occupy a 280–320 px inspector; timeline and transport stay together below the viewer. Use Cut, Transform, Text and Audio sections. Keep cut start/end beside the active region. At narrower widths the inspector becomes a tool drawer; do not shrink controls until they become illegible.

**Import:** drop/choose files or paste a URL → inspect when needed → choose item/quality → import/download progress → Open in editor. Multiple file imports should land in Library with a clear selection instead of repeatedly opening each source and leaving the last one selected. Account cookies appear only when needed, with the existing protection/consent semantics retained.

**Trim:** source playback → I/O or drag region handles → numeric precision if needed → play selected region → optionally render the edited result. Show kept duration and resulting order. Add drag handles as a new capability with keyboard/numeric equivalents, not as a styling-only change.

**Export:** open Export → choose preset and quality/size goal → see output name, duration, dimensions and encoding summary → review material changes → start export. Show MB/MiB units clearly while keeping exact byte values available. Distinguish an estimated size from a guaranteed enforced ceiling and measured completed size. Never silently change exact cuts into keyframe cuts.

**Progress and result:** visible job stage (Preparing/Downloading/Encoding/Validating/Complete); progress and ETA only when meaningful; cancel/retry with explanations. Completion shows the actual output and Open/Download/Copy/Reveal as supported. A failed validation must never produce a green success state. External upload handoff remains distinct from confirmed upload success.

**Preview:** original playback is labeled. If local approximations of crop/rotation are later introduced, mark them as approximate. A rendered preview has a preparing/progress/cancel state and is bound to the exact recipe/options revision. Reuse matching completed output where possible. Short sample renders would be a future performance feature, not a claim about the existing implementation.

## Suggested implementation order and acceptance criteria

1. **Protect continuity.** Persist drafts and restore them after navigation/reload. Queue → Editor must preserve trim bounds, transforms, export settings, playhead and selected region. Save/load must round-trip the same data. Add focused regression tests here.
2. **Restructure the workspace.** At 1440 × 900 and 1366 × 768, keep viewer, timeline, in/out and Export available without scrolling the entire editor. Scope scrolling to long lists/inspectors and preserve keyboard access and zoom/reflow behavior.
3. **Simplify export and preview.** Basic export should not require entering bytes or knowing a codec. Advanced users retain exact values. A changed recipe invalidates stale plans/results visibly. Preview must not create indistinguishable library clutter.
4. **Improve navigation and media recognition.** Projects become easy to reopen; Library gains search/filters and thumbnails; jobs use meaningful names and recovery actions. Keep administrative settings out of routine navigation.
5. **Apply and verify the visual system.** Light/dark parity; text/non-text contrast; focus visibility and order; keyboard-only trimming/export; target sizes; reduced motion; 200% zoom; long names; 50-item queues; portrait/audio-only media; empty, loading, error and offline states.

Validate with a small formative study of representative users performing three tasks: import and trim two regions, export under a chosen size ceiling, and resume a project after checking Jobs. Record completion, wrong turns, mistaken exports and confidence about source versus result. Compare against the captured baseline before calling the redesign successful. No measured user-preference or productivity claims are made in this report.
