# Concept 1 interface

This change implements the approved editor-first desktop and mobile references in the existing React application. Media processing, authentication, permissions, storage, and export validation retain their existing implementation.

The editor uses a labeled tool rail, a contextual inspector, the original-source viewer, an export summary, and a source-time timeline. White controls mark selection and the next action against near-black surfaces. Borders replace gradients and decoration. Square controls and Arial keep the interface readable at compact desktop sizes. The timeline uses actual source duration and timestamps; it does not reproduce illustrative reference geometry.

Design read: a media editing workspace for nontechnical users, with a quiet monochrome interface. Energy 1, rhythm 1, motion 1. Predictable geometry keeps recurring controls in the same place; motion is limited to short control feedback and respects reduced-motion preferences.

On a narrow screen the viewer and timeline span the available width. Labeled tools stay above bottom navigation, with room reserved for the device safe area. A tool tap brings the relevant inspector into view; Done returns to the preview. The More menu opens upward within the screen. Start and end fields remain available alongside pointer and keyboard trim handles. Rendered preview and reviewed export remain separate from original-source playback.

Library, Jobs, Add media, Settings, presets, integrations, administration, and the connection screen use the same contrast and control system. Advanced media settings and integration details remain accessible without occupying the primary workflow.

## Validation

The change addresses the interface portions of S06, S12, A09, A10, A11, A12, and A21. Existing media and security tests remain the authority for backend correctness.

Run:

```powershell
npm ci
npm run build
npm test
npm run test:ui
npm run test:responsive
```

The responsive browser check starts an isolated local service on an ephemeral port and uses generated media. It checks narrow and wide layouts, real trim and export behavior, navigation, text contrast, touch targets, keyboard focus, long names, and error states. It writes actual UI screenshots and a machine-readable report under `test-output/responsive`.

Verified on Windows with Node 24.17.0, installed Microsoft Edge, FFmpeg/ffprobe 9.0.1, and the pinned yt-dlp tool:

- Build and TypeScript checks passed.
- `npm test`: 78 passed, 15 explicitly skipped, zero failed. The skipped platform and opt-in cases are not claimed as verified.
- `npm run test:ui`: all 34 existing browser workflows passed. The real transformed export was 14,427 bytes against a 30,000-byte limit, decoded to eight frames, and played in the browser. URL inspection/download tests use a local fixture server.
- `npm run test:responsive`: 103 checks passed, with zero application errors. The editor was checked at 1528×900, 1366×768, 1024×768, 390×844, 320×740, 768×1024, and 844×390. Supporting pages were checked at 1528px, 390px, and 320px. Checks cover overflow, AA text contrast, 44px mobile controls, toolbar hit testing, inspector reveal/return, landscape frame visibility, keyboard and pointer edits, reviewed export, theme restoration, error states, and long filenames.
- The existing contextual-editor browser check passed using generated eight-second media, including persisted text styles, canvas dragging, keyboard resizing/movement, selection, and mobile layout.

The responsive check caught a rendered-preview dialog inside collapsed playback options. The dialog now renders outside that collapsed ancestor; a regression verifies the desktop header action opens it and plays the validated edited file while playback options stay closed.

Actual before screenshots are under `test-output/before`; final browser screenshots and the responsive report are under `test-output/responsive`. Test media and service data are isolated from personal media. The existing benchmark and Display services were not modified.

This validates the browser interface on the tested Windows environment. Linux/Docker, opt-in live sites, native desktop handoffs, and an Electron release package were not revalidated by this UI change. No backend, media-processing, authentication, authorization, or storage implementation changed.
