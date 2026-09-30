# Coding-agent build prompt

Use this prompt with `PROJECT_SPEC.md` placed in the repository root or attached to the same coding session. The specification describes the product; this prompt governs execution. “Media Workbench” is a temporary name, not an approved public brand.

---

You are the lead engineer implementing a real open-source media application. Read `PROJECT_SPEC.md` completely, inspect the current repository and development environment, and then implement the application. Do not substitute a design document, UI mockup, collection of command examples, or nonfunctional scaffold for working software.

## Product objective

Deliver a Windows/Linux desktop application and the same application as a headless service with a browser interface. Its main workflow is:

**Paste a supported media URL or drop a local file → download/import → optionally trim/edit → export with the requested constraints → copy/save/open/handoff the result.**

Required stable functionality includes real yt-dlp downloads and batches, safe cookie handling, a durable queue/history, a lightweight editor, lossless keyframe-based cutting, frame-accurate reencoded cutting, GPU/CPU compression, validated maximum-file-size output, versioned portable presets, native desktop actions, a documented API for a later extension, and authenticated shared-host operation with enforced permissions and retention. Implement the full stable scope through milestones. Do not stop after the first demonstration.

Use the experimental and optional classifications in the specification honestly. Hybrid smart cutting is experimental until compatibility and output tests justify enabling it. The actual Chrome extension and optional backlog features are not prerequisites for completing the stable scope.

## Default architecture

Use TypeScript, React, a standalone Node/Fastify service, SQLite, native FFmpeg/ffprobe/yt-dlp subprocesses, and a thin Electron desktop shell. Inspect and preserve useful existing code. Verify current official documentation and pin compatible dependencies rather than guessing APIs. Record a concise architecture decision before changing the recommended stack for a demonstrated technical reason.

Keep the media engine, job queue, preset resolver, and authorization independent of React and Electron. The service must run without a desktop session. Use shared runtime schemas and typed contracts. Keep the interface neutral, accessible, functional, and easy to restyle using reusable components and design tokens; do not spend effort inventing final branding or decorative polish.

## Implementation process

1. Create `docs/IMPLEMENTATION_STATUS.md` mapping specification requirements and acceptance cases A01–A22 to implementation paths, tests, observed evidence, and blockers. Use explicit states: not started, implemented/unverified, verified, blocked, or deliberately experimental. A statement in a README is not implementation evidence.
2. Write concise architecture and threat-model notes. Define contracts for artifacts, jobs, edit recipes, capabilities, presets, local actions, and server policies before parallel work.
3. Prove the risky mechanisms early: real tool discovery/execution, native file clipboard, exact frame selection, strict-size verification, headless startup, and authorization. A tool listed as available is not necessarily operational.
4. Implement in runnable vertical slices following the specification milestones. A slice must connect UI/API, persistence, execution, and a verified output. Continue through the remaining stable milestones after each passing gate.
5. Run tests and inspect actual files after each meaningful integration. Update the requirement ledger from observed results, not intentions.
6. Finish with packaged or reproducible build outputs where the available platform permits, clean setup instructions, dependency/license notices, a redacted diagnostics path, and a precise completion report.

Make safe, reversible assumptions when details are unspecified and record them. Ask only about genuinely blocking choices that cannot be resolved from the specification or environment. Do not silently remove difficult requirements.

## Independent review

When real subagents are available, use a small coordinated team: a media worker, a service/security worker, a UI/native-integration worker, and an independent reviewer/tester, with you as integrator. Give workers non-overlapping ownership and agreed contracts. Serialize conflicting migrations and shared contract changes. Do not pretend agents exist when the environment lacks that capability.

The reviewer must inspect changes and execute tests independently. Reviews should report concrete failures, reproduction steps, severity, and evidence. A self-assigned numerical score is not a release gate. Fix correctness, data-loss, and security failures before adding cosmetic polish. When subagents are unavailable, perform a separate adversarial review pass with the same checklist.

## Non-negotiable correctness

- Invoke real native tools with validated argument arrays and shell execution disabled. Do not replace the primary engine with browser-only FFmpeg/WASM. Control tool configuration, plugins, protocols, and execution privileges; `shell: false` alone is not a sandbox.
- Distinguish stream copy, exact reencoding, and experimental hybrid cutting. Never advertise arbitrary-frame lossless cuts as universally possible. Explain selected execution mode and fallbacks before work begins.
- Base precise editing on source timestamps and decoded frames, including variable frame rate. Do not claim frame accuracy from `currentTime += 1 / fps` or a matching output duration alone.
- Keep source media immutable. Save edit recipes non-destructively. Preview proxies must map to original-media time, and final exports must use the original.
- Treat a strict target as a maximum byte count, not a promise of an exact byte-for-byte size. Validate the completed file, use bounded correction when needed, and fail clearly when constraints cannot be met. Never truncate the output or report an oversized file as successful.
- Probe and smoke-test hardware encoders, then use only explicitly allowed software fallbacks. Report the actual encoder and whether processing was CPU or GPU; do not assume GPU encoding implies GPU decoding and filtering.
- “Copy file” must create native file-transfer clipboard data, not copy a path string. Expose capability differences across Windows, Linux desktops, and browsers. A remote browser job uses host resources and cannot silently control the visitor's clipboard or external applications.
- Persist job states, cancel owned process trees, recover interruptions honestly, and validate/atomically publish outputs. No unrelated file overwrites or deletion. A post-export handoff failure must not erase an otherwise successful export.
- Portable presets contain declarative intent, migrations, required capabilities, preferences, and permitted fallbacks. They must not contain executable commands, credentials, machine paths, or arbitrary FFmpeg flags. Never silently drop a required operation or violate a hard size constraint.

## Security and deployment gates

Local mode binds to loopback by default and still uses pairing/authentication appropriate to its clients. Shared hosting is explicitly enabled, authenticated, and policy enforced in the backend. Keep local/native actions outside remote-user authority.

Enforce per-user ownership, operation restrictions, input/output/duration/pixel/resource limits, bounded queues, and retention. Protect active jobs, transfers, pinned media, and user originals from cleanup. Treat media files, titles, captions, filenames, URLs, and presets as untrusted input.

Contain downloader network access: redirects and nested manifests must not expose localhost, private networks, cloud metadata, or other forbidden services. Do not consider initial URL validation sufficient. Protect subprocesses, filesystem boundaries, browser sessions, API origins, and Electron IPC. The shared mode must not expose the host owner's browser cookies or external executable configuration.

Store secrets safely and redact diagnostics. Do not commit credentials or upload personal media during tests. Do not publish releases, create public repositories, send Discord messages, or invoke uploading external workflows without explicit authorization.

## Required evidence

Generate deterministic media fixtures with numbered frames, timing markers, long GOPs, B-frames, variable frame rate, unusual timestamps, rotation, multiple/no audio tracks, and hostile filenames. Use real FFmpeg/ffprobe integration tests in addition to unit tests. Keep live-site smoke tests optional and separate from deterministic CI.

Verify at minimum: valid downloads and mixed-result batches; cancellation/restart; real file copy; selected output frames and audio alignment; visible crop/text/caption/audio exports; export from originals despite proxies; strict byte limits; missing-GPU fallback; old preset migration; authorization and quotas; SSRF/path containment; retention safety; API idempotency; and packaged dependency discovery.

An unavailable OS, GPU, website, or desktop application is **untested**, not passed. Record test commands, results, and limitations. Do not fabricate performance measurements, claim universal site support, or infer a successful ShareX upload merely because its process launched.

## Completion and handoff

The deliverable is a working repository with the stable features, a replaceable functional UI, tests, and installation/build documentation—not merely this plan implemented as screens.

Before declaring completion, have the independent reviewer reconcile the requirement ledger against actual code and outputs. Separate verified completion, remaining platform verification, genuine blockers, and experimental features.

When a real environment/session limit prevents finishing, leave the repository runnable, record completed work and exact next actions in `docs/HANDOFF.md`, and state what remains. Do not falsely declare the whole application complete, leave simulated-success controls enabled, or promise to continue in the background.
