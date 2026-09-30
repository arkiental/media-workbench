# Media Workbench — Product and Engineering Specification

**Status:** Proposed build specification, not an implemented application.  
**Prepared:** 12 September 2026.  
**Working name:** Media Workbench; replace before public release after checking availability.  
**Platforms:** Windows and Linux desktop; local browser; optional authenticated shared server.  
**Design status:** A functional neutral interface now; final visual design later.

## 1. Product purpose

Build a local-first, open-source application that turns an online video or local media file into a shareable clip. The primary workflow is:

**Paste URL or drop file → obtain media → optionally trim/edit → fit an output requirement → copy, save, or hand off the result.**

The owner wants software they personally use and can release and maintain publicly. Adoption should come from reliability, convenience, privacy, and a clear purpose, not a large checklist of partially implemented tools. Applying to an open-source maintainer support program is a possible later benefit, not a product dependency or promised outcome.

The documented OpenAI offer checked during planning is six months of ChatGPT Pro with Codex for selected maintainers, with other conditional benefits; it is not a promise of permanent unlimited access. Selection considers usage, ecosystem importance, maintenance, and other factors. Recheck official terms before applying. [R1–R3]

### Primary user story

A Windows user pastes a video URL, downloads the relevant media, previews it, optionally selects a short segment, exports a clip under a chosen byte limit, and copies the actual file reference for pasting into another application. They can instead reveal it in Explorer, open an external editor, or invoke a configured ShareX workflow.

### Additional user stories

- A Linux user performs the same media workflow, with accurately reported desktop-integration capabilities.
- A user pastes multiple URLs and gets a durable, item-by-item queue and result report.
- A user imports a shared preset made on different hardware or an older app version and sees a safe migration and compatibility explanation.
- A server owner grants other people restricted download/edit access with quotas and retention rules.
- A future browser extension submits jobs through a documented, paired interface.

### Non-goals for the first stable release

Do not turn this into a full multitrack nonlinear editor, cloud video platform, social network, public anonymous download proxy, arbitrary plugin execution host, or DRM-circumvention product. Support authorized media workflows. Do not add mandatory accounts, cloud uploads, analytics, AI inference, or API keys to local use.

Local transcription, image/GIF tools, watch folders, a public preset registry, and the complete browser extension are optional follow-on work. The API foundation is required now. Experimental hybrid smart cutting remains part of the roadmap but is not a prerequisite for shipping reliable lossless and exact-reencode modes.

## 2. Recommended architecture

Use a TypeScript monorepo, React web interface, standalone Node.js service with Fastify, SQLite persistence, and native FFmpeg/ffprobe/yt-dlp subprocesses. Use Electron as a thin first desktop shell. These are proposed implementation choices, not requirements to copy specific library APIs from memory; verify supported releases and pin compatible versions when building.

Electron provides a Chromium renderer and Node-based main process. Tauri instead uses platform webviews, including WebView2 on Windows and WebKitGTK on Linux. Prefer Electron initially to reduce desktop-renderer variation and keep most application code in one language. This does not guarantee codec support: playback still needs runtime checks and proxies. [R4–R7]

```text
Electron desktop shell                  Browser / future extension
  native capabilities                         HTTP client
             \                                  /
              shared React application + typed API client
                                |
                     authenticated API service
                                |
             domain services + capability / policy resolver
                                |
                 durable jobs + media execution planner
                                |
                    FFmpeg / ffprobe / yt-dlp
                                |
                  SQLite + managed artifact storage
```

Suggested repository:

```text
apps/
  desktop/          Electron main/preload, startup, native adapters
  web/              React screens and view-specific state
  server/           HTTP routes, sessions, lifecycle, configuration
packages/
  contracts/        runtime schemas, OpenAPI, typed API client
  core/             recipes, presets, policy, capability resolution
  media/            probing, execution plans, FFmpeg/yt-dlp adapters
  jobs/             queue, persistence, leases, retries, cancellation
  platform/         browser/desktop capability interfaces
  ui/               neutral reusable controls and design tokens
  test-fixtures/    generated media and deterministic HTTP fixtures
```

Merge small packages when separation adds overhead without a real boundary. No Kubernetes, Redis, separate microservices, or distributed queue is needed for the single-host initial design.

### Architecture rules

- Media logic must not import Electron, React, DOM APIs, or presentation components.
- UI calls typed domain/API operations, not shell commands.
- The service runs without Electron installed or a graphical session.
- SQLite stores metadata and job state; large media lives on disk.
- Use a single service owner for database writes and worker orchestration initially. Do not put the database on unsupported shared/network storage or pretend this is a multi-host worker architecture.
- Native tools run in supervised child processes, not on the UI/event loop. Use argument arrays with shell execution disabled; also validate option-level semantics.
- Launch the service automatically with the desktop app. Make process ownership, shutdown, tray behavior, port conflicts, and service reuse explicit.
- Build desktop mode and local-browser mode from the same service and web code. Changes to the future visual design should not change media commands, API contracts, or preset schemas.

## 3. Execution modes and capability boundaries

| Mode | Processing and storage | Native desktop operations |
|---|---|---|
| Desktop | User's machine | Through narrowly scoped native adapters |
| Local browser | Machine running the local service | Only explicitly paired companion capabilities; not assumed from browser access |
| Shared server | Server machine | Unavailable on the visitor's machine unless they separately pair a companion |

Remote users upload inputs when needed and download completed results. The server's GPU performs encoding. A server job does not automatically use the visitor's GPU, browser cookies, Explorer, clipboard, or ShareX installation.

Expose capabilities such as `fileClipboard`, `nativeDragOut`, `revealFile`, `externalActions`, `hardwareEncoders`, `sharedHosting`, and `cookieImport`. Distinguish unavailable, permission-denied, and temporarily failing states. The frontend should explain or hide unsupported actions rather than present dead controls.

Browser clipboard access is constrained by browser support, security context, permissions, and user activation. File-manager-style file copy requires platform integration and must not be implemented as copying a path string. On Windows, implement an appropriate shell file-transfer representation such as CF_HDROP and test actual target applications. Test Linux desktop environments separately rather than assuming identical behavior. [R8–R10]

When the desktop client connects to a remote service, native actions first require an authorized local copy of the server artifact. Never pass a remote server path into a local clipboard or application launcher.

## 4. Core domain model

Define explicit, versioned entities:

- **Source:** original URL or local import reference, owner, provenance, source-media identifier, metadata, and retention ownership. URLs can contain sensitive information and are access-controlled.
- **Artifact:** immutable completed file, byte size, media metadata, owner, parent source/job, storage class, retention, and validation result.
- **Project / edit recipe:** non-destructive edit instructions referencing original media, with source-time coordinates and a schema version.
- **Job:** requested operation, resolved plan snapshot, tool versions, state, progress, cancellation, resource usage, and owned artifacts.
- **Batch:** ordered child jobs, common defaults, per-item overrides, and aggregated results.
- **Portable preset:** shareable declarative intent, compatibility metadata, constraints, preferences, and permitted fallbacks.
- **Local action binding:** executable or destination configuration scoped to the trusted machine/user; never implicitly portable.
- **Policy:** server-enforced permissions, limits, allowed operations, storage, and network restrictions.

Use opaque artifact IDs in general APIs, not arbitrary filesystem paths. Keep local owner file registration separate from remote upload endpoints. An artifact ID is not authorization: validate ownership or an explicit share grant on every access.

## 5. Downloading and media library

### Required behavior

Accept one URL, multiple pasted URLs, and local file drops/imports. Use yt-dlp as the initial online-video provider. Expose adapter boundaries for additional providers later without writing new site scrapers during the initial build.

For the priority sites—YouTube, X/Twitter, and Reddit—provide explicit integration tests and a support-status report tied to tool versions and test dates. Do not promise that every post or future site change will work. Other yt-dlp extractors can be available on a best-effort basis subject to server policy.

Before downloading, present available media, title, duration when known, formats, resolution, audio/video options, estimated size when available, and whether authentication is needed. Handle a post with multiple videos and a video URL containing playlist context without unexpectedly downloading an entire playlist.

Provide quick-download defaults and an advanced selection panel. Keep a broadly compatible sharing output preference separate from an original/best-source preference. Source format availability may require remuxing or re-encoding; explain the selected behavior.

Optional selected-range downloading should reduce transfer where the source/protocol allows it. Show when a full download is necessary; do not promise arbitrary instant seeking into every online source.

### Batch and history

Default to sequential downloads, as requested. Allow bounded concurrency in settings subject to server policy. Record per-item status, original URL, selected settings, output metadata, warnings, and redacted diagnostics. Support retry-failed, cancel-item, cancel-batch, reorder-pending, duplicate detection, and JSON/CSV result export.

Use durable state transitions and idempotency keys. Detect interrupted jobs at startup. Resume downloads only where supported and verified; otherwise restart the affected step with a clear explanation. Do not promise resumable encoding or working pause buttons where a tool cannot provide them safely.

### Cookies and credentials

Offer explicit local browser-profile extraction where supported and a Netscape cookies-file import. Explain which account/profile is being used and allow forgetting it. Browser extraction can fail because of permissions, encryption, profile locking, or platform changes. Provide actionable errors rather than asking users to disable browser protections.

yt-dlp supports browser cookies and cookies files; its FAQ warns that exporting a cookie jar can include cookies for all sites. Minimize retained credentials, protect them with OS-backed storage where available, use permission-restricted temporary files only when necessary, and never place cookies in logs, presets, crash reports, repository fixtures, or general job responses. [R11–R12]

Shared hosting must not expose the host owner's logged-in sessions to guests. Disable guest credential import initially unless per-user isolation and retention have passed review. Any later upload of cookies to a remote host must explicitly disclose that the host receives those session secrets. Do not silently relay browser cookies through the extension.

### Toolchain management

Detect and report versions of FFmpeg, ffprobe, yt-dlp, and any required runtime. Current yt-dlp documentation describes a supported JavaScript runtime and EJS components for full YouTube support; account for this rather than assuming the desktop executable supplies an invocable standalone Node binary. [R11]

Provide reproducible pinned tool builds, trusted-source manifests, integrity verification, update/rollback support, and independent yt-dlp updates after compatibility checks. Do not allow remote users or imported presets to specify binary download URLs, plugin directories, arbitrary yt-dlp configuration, or execution hooks. Disable ambient user tool configuration/plugin loading where it could bypass the application's policy.

## 6. Editor and preview

Build a lightweight single-source clip editor rather than a full nonlinear editing suite.

Required controls: play/pause, zoomable and scrollable timeline, thumbnails, audio waveform, playhead, editable in/out times, frame stepping, keyframe stepping, snapping, multiple kept/removed segments from one source, undo/redo, and project save/load.

Required edits: trim/cut, crop, resize, rotate, timed text overlays, caption import/edit/export, burn-in or supported soft subtitle tracks, audio track selection, mute/remove, volume adjustment, fades, normalization, and basic replace/add-audio behavior. Define how duration and sync behave when replacement audio is shorter or longer.

Store edits non-destructively. Export from the original source, not an earlier compressed export or a low-quality preview proxy. Define operation order, crop coordinate space, orientation handling, subtitle timing through cuts, and source-to-output timeline mapping.

### Accuracy and responsiveness

Do not implement frame stepping solely as `currentTime += 1 / averageFPS`. Index real frame presentation timestamps, using ffprobe/frame decoding where appropriate. Handle variable frame rate, rational timebases, B-frames, stream offsets, and nonzero starting timestamps. Define in-inclusive/out-exclusive semantics and convert only at explicit boundaries. ffprobe exposes frame and packet information, but even interval seeking is not inherently exact. [R13]

Use a fast normal preview and a source-accurate frame inspection path for exact cut decisions. Extract/index small windows around the playhead and cache results; do not synchronously decode every frame of a long file before editing starts. Generate thumbnails/waveform progressively with cancellation.

If browser playback cannot decode the source, use an explicit preview proxy with timestamp mapping. Display proxy status and keep exports on the original. LosslessCut uses a similar original-versus-preview distinction. [R14]

Prefer preview rendering that shares edit semantics with export. For text/subtitles, confirm font availability and crop/scale order; do not assume a CSS overlay will perfectly match FFmpeg rendering. Display a final representative export preview where needed. Preserve rotation and color metadata appropriately; detect HDR and avoid silent washed-out SDR output. Unsupported HDR transformations should be reported, not silently guessed.

## 7. Export planning: separate editing accuracy from compression

The execution planner resolves a recipe, preset, media capabilities, installed tool capabilities, and host policy into an explicit plan. Show which streams are copied, encoded, or discarded and why.

### Cutting strategies

**Fast lossless/keyframe cut:** Copy eligible encoded streams without re-encoding. Display actual usable cut positions and any snapping/offset. This is typically fast but still requires reading/writing data, and arbitrary inter-frame cut points are not generally exact. Never claim literal zero-time processing. [R15–R16]

**Exact cut:** Decode through the necessary region and re-encode the selected video with timestamp-aware boundaries. Choose hardware or software encoding independently. Validate the first/last visible frames and audio alignment. Label quality changes accurately.

**Experimental smart cut:** Re-encode necessary boundary regions and copy compatible interior regions. Limit it to a verified codec/container matrix, test stitch points, timestamps, audio, and decoder behavior, and fall back only according to an explicit policy. LosslessCut's smart cut is experimental and documents boundary/sync limitations. Do not promise universal compatibility or require its completion before stable exact cutting can ship. [R16]

**Automatic:** Prefer copy only when the requested edits, boundaries, destination, and constraints permit it; otherwise select an explained encoding path. Cropping, scaling, burned-in text, and filtered streams cannot simply use stream copy. Track removal, metadata edits, and some remuxing operations can avoid video encoding. [R15]

Do not call stream copy “lossless compression.” Lossless re-encoding is also not a promise of a smaller file than an already compressed source. Present an optional archival lossless codec mode separately if implemented.

### Compression choices

Implement quality-targeted, bitrate-targeted, target-size, and automatic output modes. Offer speed/quality preferences separately from codec, resolution, frame rate, and cutting strategy. Include H.264, H.265, and AV1 where the verified build and hardware support them; include software fallbacks permitted by the user's policy.

Probe installed encoders and run short representative encode tests. A codec name in an FFmpeg build is not proof that the current hardware/driver can execute it. Distinguish GPU encoding, decoding, and filtering, and do not imply that every operation uses the GPU. [R15]

Cache capability results keyed to tool version, relevant device/driver identity, and test parameters. Report fallback reasons and allow strict “do not use software” constraints.

### Target-size contract

The primary contract is **a complete, valid output at or below the requested maximum bytes**, not an exact byte count. Clearly distinguish MB from MiB; store limits in integer bytes. Do not hardcode a chat platform's upload limits as timeless facts.

Use the edited output duration and reserve room for audio, subtitles/attachments if retained, and container overhead. An initial estimate is:

```text
video_bitrate_bps = 8 * (target_bytes - reserved_overhead_bytes)
                    / output_duration_seconds
                    - total_audio_bitrate_bps
```

This is a starting estimate, not a guarantee. Use a supported two-pass software path for predictable size targeting where appropriate, or a hardware bitrate-targeting path with final measurement. Verify actual bytes and decode validity, and perform a bounded correction loop. A suggested default is at most two additional encode attempts, exposed in the plan and constrained by server policy.

If the limit is infeasible under the selected quality/resolution/audio constraints, explain that and propose permitted changes. Do not silently drop required audio, lower resolution, change aspect ratio, or truncate the output. FFmpeg file-size stopping is not a substitute for a valid full-duration target-size encode. Never return oversized output as a successful strict-size result.

## 8. Output actions and desktop integration

The completed-artifact panel should provide preview, copy file, copy path, reveal in folder, save as, drag out where supported, edit, and configured external actions. Keep copy-file and copy-path separate.

External-action configuration should contain a local executable binding, an argument array, permitted placeholders, applicable media types, confirmation policy, timeout, and whether the action uploads data. Expand placeholders into individual arguments, not shell source. Use a local registration ID rather than a remotely supplied executable/path.

ShareX documents file-path upload and a `-task` selector for configured workflows. Implement an adapter against verified CLI behavior rather than assuming that moving a file to a directory uploads it. Passing a file to ShareX starts a handoff; do not report upload success or invent a resulting URL unless an actual completion/result integration confirms it. [R17]

Only trusted local owners can configure executable actions. Shared-server users cannot run commands on the host. A portable preset may reference an unresolved logical action name, but importing it cannot authorize execution or contain machine paths, credentials, scripts, or arbitrary FFmpeg arguments.

Automatic actions are opt-in. Bind them to a specific successful job/output, not a global race-prone “last file.” Provide an explicit “copy latest successful output” command with defined current-user/session semantics. Keep clipboard-referenced artifacts alive long enough for normal pasting; never let aggressive cleanup immediately invalidate a file copy.

## 9. Portable, versioned smart presets

Keep three configurations separate: portable media intent, local machine/action bindings, and administrator policy. Neither an import nor a migration can grant permissions or override administrator restrictions.

Example portable intent, not a finalized public schema:

```json
{
  "schemaVersion": 1,
  "id": "shareable-clip",
  "revision": 1,
  "name": "Shareable clip",
  "requires": ["target-size-v1", "exact-cut-v1"],
  "video": {
    "codec": "h264",
    "container": "mp4",
    "maxHeight": 1080,
    "encoderPreference": "hardware",
    "allowSoftwareFallback": true
  },
  "audio": {"policy": "keep", "codec": "aac"},
  "export": {
    "maxBytes": 20000000,
    "sizePolicy": "must-not-exceed",
    "cutAccuracy": "exact"
  },
  "fallbacks": {"allowResolutionReduction": false}
}
```

The 20 MB figure is an example user-selected limit, not a claim about any platform's allowance.

### Compatibility behavior

Validate against a schema; migrate supported old schemas through deterministic, tested migrations; preserve the original imported payload and show material changes. Resolve declarative preferences against current hardware and installed tools, then apply host policy. Store both the portable preset and the exact resolved plan in each job for diagnostics and reproducibility.

Treat required intent differently from optional preferences. A missing preferred encoder may fall back with a warning if allowed. A missing required crop, subtitle operation, size ceiling, or accuracy capability blocks execution rather than silently disappearing. Unknown newer required features must be rejected clearly. Preserve only safely namespaced unknown optional data for round-tripping; never execute it.

Use stable machine IDs for settings, not UI labels or component property names. Specify a backward-compatibility support policy and keep migration fixtures. Arbitrary future presets cannot be guaranteed to work in older software. User-edited copies must not be overwritten by built-in preset updates. A hosted preset marketplace and remote subscriptions are not needed for version one: JSON import/export is sufficient.

## 10. Shared hosting, API, and future extension

### API foundation

Use versioned, documented HTTP endpoints and authenticated event delivery. Suggested routes:

```text
GET    /api/v1/capabilities
POST   /api/v1/sources/inspect
POST   /api/v1/uploads
POST   /api/v1/jobs
GET    /api/v1/jobs/{id}
POST   /api/v1/jobs/{id}/cancel
GET    /api/v1/events
GET    /api/v1/artifacts/{id}/content
POST   /api/v1/presets/validate
POST   /api/v1/presets/import
POST   /api/v1/pairings
```

Create OpenAPI documentation, runtime input validation, scoped/revocable credentials, per-user result visibility, idempotent submissions, and useful structured errors. A capabilities response should include implemented features, verified hardware options, caller permissions, and effective limits. Do not expose secrets or unnecessary host paths in responses.

Use HTTP range delivery for media previews and downloads where appropriate. Authenticate range requests, thumbnails, project files, logs, and event streams as strictly as the main API. Do not put long-lived secrets in URLs or globally broadcast all users' job events.

### Extension design

The future extension should send a URL, optional time range, preset ID, and requested permitted completion behavior. Site content scripts send requests to the extension's trusted background/service-worker context; they do not hold account tokens or native execution privileges.

For remote servers use a paired, scoped HTTPS API client with explicit host permissions. For the installed desktop app, evaluate native messaging as the preferred companion transport; Chrome supports allowlisted extension origins and native-host registration. A local authenticated HTTP transport is also possible, but do not treat loopback alone as authorization. The extension does not need to be fully implemented in this build. [R18–R19]

Opening/focusing the application and local post-actions belong to the companion layer. An ordinary remote web request cannot directly copy a file into the visitor's native file clipboard. Browser-only mode should provide download and a user-initiated supported action instead.

### Host policy

Provide at least owner, member, and restricted-guest roles, with per-capability grants. Enforce limits in the backend: allowed sites, downloadable/uploadable size, duration, resolution, codecs, expensive filters, encoder choices, job concurrency, queued count, CPU/runtime limits, disk usage, bandwidth, and retention. A “download only” role must be rejected by processing routes, not merely have editor buttons hidden.

Shared hosting is an explicit opt-in. Bind to loopback by default. A network-exposed configuration must not run with missing authentication or an unset owner credential. Provide safe reverse-proxy/TLS deployment instructions and a non-root Linux container. A tunnel does not replace authentication and policy.

### Security gates

Treat URLs, media, titles, filenames, playlists, captions, presets, and tool output as untrusted. Prevent command/option injection, path traversal, symlink escapes, cross-user object access, cross-site request forgery where applicable, browser-origin attacks, and resource exhaustion. Validate Host/Origin where relevant to local services; CORS is not authentication. Harden Electron with context isolation, sandboxing, disabled renderer Node integration, narrow IPC, and a restrictive content policy. [R4]

URL download services create server-side request-forgery risks. Enforce a permitted network policy through redirects, DNS resolution, IPv4/IPv6, media/CDN URLs, and nested HLS/DASH resources—not just the submitted URL. Block private, loopback, link-local, and cloud metadata destinations except explicitly isolated owner-approved use cases. Apply worker-level egress restrictions as defense in depth, so external download tools cannot bypass application checks. Processing workers should not need internet access. [R20]

Review all tool options for filesystem/network/code-execution implications; `shell: false` alone is not a complete sandbox. In shared mode isolate worker filesystem access to each job and required read-only tools. Apply limits while data is streaming, not only after downloads finish.

## 11. Persistence, cleanup, and diagnostics

Use a durable job state machine with explicit queued, preparing, downloading, processing, validating, completed, failed, cancelling, cancelled, and interrupted states as applicable. Separate successful media export from failed optional upload/clipboard post-actions. Record raw exit status and a redacted diagnostic tail without presenting secrets.

Cancellation must terminate the complete process tree, with graceful shutdown followed by a bounded forced kill. Keep intermediate files in job-specific directories. Publish final output only after validation using safe, collision-resistant finalization; never overwrite an unrelated file. Recover interrupted state after crashes without falsely declaring success.

Separate externally owned local originals, managed downloads/uploads, outputs, project dependencies, preview caches, and temporary files. Cleanup may delete only app-owned eligible files. Use active-job and active-transfer leases, project pinning, configurable expiry, disk quotas, and safety checks against directory traversal/symlink races. “Delete history” and “delete media” are distinct actions. Do not delete local imported originals automatically.

Provide a local diagnostic page with tool versions, verified capabilities, recent failures, and sanitized command plans. Export a redacted support bundle only after review. Telemetry is absent by default; do not include secret URLs, cookies, filenames, or user media in automatic reporting.

## 12. Functional placeholder UI

Implement these neutral screens: quick input, queue/history, media details, editor, export options, presets, integrations, settings, and owner-only server administration.

Use accessible native-like controls, keyboard focus, readable labels, sensible spacing, responsive layouts, and centralized CSS design tokens. Include clear progress and genuine error/recovery states. Every visible enabled action must have real behavior. Unsupported and future capabilities should be hidden or explicitly disabled with a reason.

Do not spend this build on branding, illustrations, decorative dashboards, large animation systems, or a custom theme engine. Styling, view structure, and domain state must be sufficiently separated for a later frontend redesign. A placeholder appearance does not justify mocked behavior.

## 13. Implementation sequence and release gates

### Milestone 0 — Foundations and technical proofs

Create requirements tracking, threat model, architecture notes, contracts, fixture generator, capability interface, service launcher, and repository tooling. Demonstrate real FFmpeg export, a real yt-dlp adapter invocation, a neutral web screen, persistent job state, and a Windows native file-copy spike if the environment permits. Identify platform blockers early.

### Milestone 1 — Personal download-to-share workflow

Implement local imports, single/batch downloads, history, metadata, basic preview, cancellation/recovery, output actions, settings, portable preset skeleton, and functional desktop/local-web builds. Add keyframe-copy trimming and a basic exact-reencode path. Establish the end-to-end path before expanding editor features.

### Milestone 2 — Editing and predictable exports

Implement the complete lightweight editor, timestamp-aware frame tools, captions/audio, proxies, GPU capability testing, compression options, strict target-size verification/correction, export explanations, full preset migrations/resolution, and reproducible test coverage. Keep source media immutable.

### Milestone 3 — Safe shared hosting

Implement user/session management, per-user artifact ownership, permission enforcement, quotas, retention, upload/download streaming, network restrictions, container deployment, and paired API clients. Do not enable public-facing mode until security gates pass. Local use continues to require no cloud account.

### Milestone 4 — Release readiness

Produce Windows and Linux packages, headless-server distribution, a compatibility/test matrix, clean-install tests, third-party notices, dependency/tool provenance, source/build instructions, contribution and security policies, migration docs, and an honest release checklist. Verify signing/update mechanisms where available; do not claim signed or published builds without doing it.

Experimental hybrid smart cut may be developed after the exact/copy foundation, under its own test matrix. The full browser extension and optional backlog are follow-on projects, not hidden substitutes for unfinished required features.

These milestones organize delivery of the full stable scope; they are not authorization to stop at an attractive skeleton. If work must stop, leave a runnable repository and an exact completion/blocker report rather than declaring the whole app finished.

## 14. Acceptance tests and evidence

Maintain a requirement-to-implementation-to-test matrix. Passing a self-written trivial test is not sufficient; validate externally observable behavior using real tools and inspected outputs.

| ID | Required evidence |
|---|---|
| A01 | Clean checkout installs and launches desktop and headless/local-web modes using documented commands. |
| A02 | Real media is downloaded through the adapter, probed, and played; failed URLs produce actionable errors. Live site checks are separate from deterministic CI. |
| A03 | Batch of mixed valid/invalid URLs finishes with correct per-item states and retry-failed behavior. |
| A04 | Cancelling each active stage stops owned child processes, leaves no completed corrupt artifact, and preserves unrelated files. |
| A05 | Restart after interruption retains history and marks/resumes/restarts work honestly. |
| A06 | Windows copy-file produces native file-transfer data and is verified in Explorer and a target application's compose/attachment UI when available; copying a text path does not pass. No live message is sent. |
| A07 | Linux native integration reports supported capabilities and passes documented desktop-specific tests; unavailable platforms are marked untested. |
| A08 | Stream-copy output has the advertised selected boundaries and decoded-frame preservation for a controlled compatible fixture; remux file hashes need not match. |
| A09 | Exact cutting includes/excludes the correct visibly numbered frames on CFR and VFR fixtures, handles nonzero timestamps, and meets a stated audio-alignment tolerance. Duration alone is insufficient. |
| A10 | Crop, rotation, text, captions, and audio changes are verified in rendered output, not only in preview controls. |
| A11 | Proxy-assisted edits export from the original at the intended source positions and resolution. |
| A12 | A strict byte-limit export either yields a complete decodable output no larger than the limit or an explicit failure; impossible constraints are not silently weakened. |
| A13 | Unavailable hardware follows only allowed fallback rules, and diagnostics name the actual encoder used. |
| A14 | Old preset fixtures migrate deterministically; unavailable required features block; allowed encoder fallback succeeds with warning; no secrets/commands are imported. |
| A15 | External action receives correctly separated arguments even for spaces, quotes, Unicode, and shell metacharacters in filenames; remote users cannot select executables. |
| A16 | Different users cannot read, enumerate, edit, delete, or subscribe to one another's artifacts/jobs without grants. |
| A17 | Download-only/cheap-processing permissions cannot be bypassed through direct API calls, presets, or parameter combinations. |
| A18 | SSRF, redirect, IPv6, nested-playlist, path traversal, symlink, hostile metadata, and malicious preset fixtures are rejected or contained. |
| A19 | Retention deletes only eligible managed files and preserves originals, pinned dependencies, running jobs, and active transfers. |
| A20 | API submission is authenticated and idempotent; pairing credentials are scoped and revocable; desktop-only actions fail safely for browser-only clients. |
| A21 | Replacing CSS/view components does not alter tested media execution, preset migration, or headless behavior. |
| A22 | Packaged toolchain works without accidental dependencies on the developer's PATH, browser profile, or globally installed runtime. |

Generate fixtures with numbered frames and audio timing markers, long GOPs/B-frames, variable frame rate, portrait/rotation metadata, multiple/no audio tracks, odd dimensions, different sample rates, corrupt/truncated content, and unusual filenames. Include HDR fixtures only with a documented expected transform or preserved behavior.

Use unit tests for planners and migrations, integration tests with actual FFmpeg/ffprobe, deterministic download-fixture tests, API authorization tests, browser UI tests, and native/manual OS tests. Live YouTube/X/Reddit tests are opt-in smoke tests with date/tool version reporting, not the sole CI suite. Do not require or publish real credentials. Missing hardware or OS access means “untested,” not “passed.”

## 15. Open-source release and adoption

Choose and document the original app's license before accepting contributions. MIT is a reasonable provisional choice for original application code when broad reuse is the priority, subject to actual dependency/composition review. Do not assume another project's open-source code is freely relicensable. The retrieved LosslessCut repository is GPL-licensed and CompressO's current LICENSE is AGPL-3.0; inspect exact revisions before reusing source. [R14, R21]

Review the exact FFmpeg binary configuration, corresponding-source/notices obligations, and all bundled runtime/tool licenses. Some FFmpeg optional libraries change licensing, and `--enable-nonfree` builds are documented as unredistributable. A separately executed tool is not an exemption from that tool's distribution obligations; linking/copying/composition questions require review. Do not bundle an arbitrary third-party “full” build without checking it. [R22–R23]

Before broad marketing, make installation and one core workflow excellent. Suggested launch demonstrations: URL to shareable attachment; long video to exact clip under a user-selected limit; and a restricted self-hosted workflow. Label measured hardware and source conditions when publishing performance claims.

Publish clear feature boundaries, reproducible examples, a roadmap, issue templates, contribution guidance, security reporting, and dependency updates. Invite a small group of actual users, fix repeated problems, then expand distribution. Treat downloads, meaningful issue reports, repeat usage voluntarily reported by users, and community contributions as useful signals; do not fabricate popularity or harvest private telemetry merely to support an application.

## 16. Optional backlog — not silently added to stable scope

Consider native drag-to-chat polish, global quick-paste hotkeys with explicit clipboard consent, watch folders, before/after sample previews, metadata privacy presets, screenshot extraction, GIF/APNG/WebP export, local automatic transcription, simple concatenation with compatibility checks, and a community preset index. Keep expensive ML features optional and separately installed.

## Reference registry

These primary sources informed constraints and compatibility notes. They are not proof that the proposed app is implemented. Recheck changing APIs, site support, licenses, and program terms at implementation/release time.

- **R1:** OpenAI, Codex for Open Source application and criteria — `https://openai.com/form/codex-for-oss/`
- **R2:** OpenAI Developers, Codex for Open Source — `https://developers.openai.com/community/codex-for-oss`
- **R3:** OpenAI, program terms — `https://learn.chatgpt.com/docs/codex-for-oss-terms`
- **R4:** Electron security guidance — `https://www.electronjs.org/docs/latest/tutorial/security`
- **R5:** Electron process model — `https://www.electronjs.org/docs/latest/tutorial/process-model`
- **R6:** Tauri overview — `https://v2.tauri.app/start/`
- **R7:** Tauri webview versions — `https://v2.tauri.app/reference/webview-versions/`
- **R8:** Microsoft, Shell Clipboard Formats — `https://learn.microsoft.com/en-us/windows/win32/shell/clipboard`
- **R9:** Electron clipboard API — `https://www.electronjs.org/docs/latest/api/clipboard`
- **R10:** MDN Clipboard API — `https://developer.mozilla.org/en-US/docs/Web/API/Clipboard_API`
- **R11:** yt-dlp repository/documentation — `https://github.com/yt-dlp/yt-dlp`
- **R12:** yt-dlp cookie FAQ — `https://github.com/yt-dlp/yt-dlp/wiki/FAQ`
- **R13:** ffprobe documentation — `https://www.ffmpeg.org/ffprobe.html`
- **R14:** LosslessCut repository — `https://github.com/mifi/lossless-cut`
- **R15:** FFmpeg documentation — `https://ffmpeg.org/ffmpeg.html`
- **R16:** LosslessCut smart-cut implementation discussion — `https://github.com/mifi/lossless-cut/issues/126`
- **R17:** ShareX command-line arguments — `https://getsharex.com/docs/command-line-arguments`
- **R18:** Chrome native messaging — `https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging`
- **R19:** Chrome cross-origin extension requests — `https://developer.chrome.com/docs/extensions/develop/concepts/network-requests`
- **R20:** OWASP SSRF prevention — `https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html`
- **R21:** CompressO license — `https://github.com/codeforreal1/compressO/blob/main/LICENSE`
- **R22:** FFmpeg legal overview — `https://www.ffmpeg.org/legal.html`
- **R23:** FFmpeg source license/build notes — `https://github.com/FFmpeg/FFmpeg/blob/master/LICENSE.md`
