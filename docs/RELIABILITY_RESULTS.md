# Reliability verification, 2026-10-11

This development change starts from v0.2.4 (`4d33f22`). It preserves the existing media workflows, authentication and resource policies. Test media and startup profiles are generated separately from user workspaces.

## Diagnosed failures and changes

- The source launcher rebuilt unchanged source on every opening. A completed build now records hashes of source, configuration, locked dependencies and output bytes. An unchanged launch reuses verified outputs; changed, damaged or missing outputs rebuild. Failed builds stop launch. Desktop readiness requires the actual ready event and successful authentication. Shutdown waits are bounded, including an unresponsive Windows process-stop helper.
- At a 1 KiB/s policy limit, the downloader proxy withheld a 64 KiB chunk for approximately 64 seconds, exceeding yt-dlp's 20-second socket timeout. The limiter now emits smaller paced portions while retaining aggregate rate and byte ceilings. Proxy DNS and idle waits are bounded; intentional stream backpressure does not become an upstream timeout. Cancellation and truncated connections clean up owned streams. The standalone shared-worker proxy received the same fixes.
- Link inspection now tolerates malformed optional fields, bounds optional thumbnail work to eight seconds and reports empty or invalid metadata clearly. Cancellation and transfer-policy failures retain their cause. An empty output cannot complete a download successfully.
- Browser requests have cancellable deadlines covering response bodies. Upload transfer inactivity and post-transfer validation have separate deadlines. Rendered-preview retry after an ambiguous submit response retains its idempotency key, recovering the durable job. Stale plans, deleted preview files and playback failures have visible recovery paths.
- Background waveform/frame analysis can fill the two per-user preview slots and return HTTP 429 for source-frame inspection. Frame images now retry only 429/503 within a bounded total wait, cancel when selection changes, release image URLs and expose loading, error and Retry frame states. Server preview limits remain two per user and four per host.
- Publication checks cancellation around file movement and restores staged files if metadata publication fails. Background startup tool checks stop with their owned server. Encoder discovery caches successful software tests and merges concurrent results; export planning can refresh incomplete readiness within the existing permission and resource policy.
- Seeking and Add section share the decoder's source-end limit, preventing an accidental one-millisecond section at the end. Mobile settings, audio presets and transform switches meet the existing 44 px touch-target requirement. The playback-options menu sits above both persistent mobile navigation rows so its frame-inspection action remains reachable. These are targeted corrections to the existing layout.

The earlier “Checking file” investigation was recorded on 2026-09-30: full decoded-frame verification of a 41-second cut took 34,398 ms for the original region and 34,623 ms for the copied output; the earlier whole job took 99,321 ms. The decoded hashes matched. Current main already contains bounded fast-copy validation and an explicit full-verification choice; this change does not claim to introduce that earlier fix or reduce validation for encoded exports. See [FAST_TRIM.md](FAST_TRIM.md).

## Owner-only device access

This section records token-protected verification. [PRIVATE_ACCESS.md](PRIVATE_ACCESS.md) describes the separate, explicit private token-free setting and how to restore token authentication. Default protection and the measurements below remain unchanged.

The tested Windows backend binds to loopback. Tailscale Serve exposes a private HTTPS route, and `MW_PRIVATE_ORIGIN` accepts that exact origin while requiring an owner credential by default. Non-owner and anonymous API requests are denied. HTTPS pairing uses Secure, HttpOnly, SameSite=Strict cookies. Bounded pairing-attempt tracking preserves rate limiting without unbounded client-map growth.

Normal TLS validation and a real mobile-sized browser verified the private pairing page (200), anonymous API denial (401), no page overflow and no script errors. No existing credential value was read for this check. Existing Tailscale routes were preserved. See [PRIVATE_ACCESS.md](PRIVATE_ACCESS.md) for generic setup and foreground session lifecycle. An actual phone remains untested. Public-hosting templates are dormant.

## Evidence and limits

Machine-readable startup, private-endpoint and regression evidence was retained on the local verification host and is excluded from public distribution. Browser screenshots and workflow evidence use `test-output/`, also excluded from the release ZIP.

`npm test` passes 203 tests, fails zero and explicitly skips 16 platform/opt-in checks (219 total, 310.57 seconds). The full run includes real downloads from controlled fixtures, mixed batches, upload/export, retry/history/restart, exact frame identity, strict size limits, cancellation and security boundaries. It started before the new frame test file existed; those eight new tests were run separately and passed. Focused startup/frame tests pass 18 checks, including real temporary HTTP 429/503-to-PNG recovery, stalled body cancellation and a never-resolving shutdown helper. The responsive browser audit passes 106 checks with 43 screenshots and no script errors. Rendered-preview fault tests pass six checks.

The final broad browser workflow passes 33 checks with no page errors. Its real transformed export is 8,435 bytes under the 30,000-byte maximum and fully decodes to eight frames. The actually displayed 320×180 source frame at requested time 0.525 seconds matches an independently decoded original RGB hash. Three targeted mobile checks pass: visible loading without overflow, four busy responses followed by a 44 px Retry frame action, and a successful fifth request with independently matching source pixels at 1.1 seconds. Evidence: `test-output/browser/evidence.json`, `test-output/responsive/evidence.json`, and `test-output/frame-reliability-UcZsbJ/result.json`. Typecheck, final build and diff checks pass. Independent review's unbounded shutdown finding was fixed and re-reviewed.

Re-run the checks with the repository's locked dependencies and verified media tools:

```powershell
npm test
npm run build
npm run test:ui
npm run test:responsive
node --import tsx tests/preview-reliability.smoke.ts
node --import tsx tests/frame-reliability.smoke.ts
node --import tsx --test tests/startup.test.ts tests/source-frame.test.ts
```

## Actual desktop startup

Each measurement uses the real Electron shell and owned service, waits for the Library heading and authenticated capabilities (200/local), checks script errors and closes gracefully. Baseline preparation reproduces the former unconditional typecheck/build; updated preparation uses the new completed-build check after a successful final build. Both use the same installed tools/dependencies and separate test profiles. No user workspace is opened.

| Profile | Baseline total | Updated total | Baseline preparation | Updated preparation |
|---|---:|---:|---:|---:|
| Fresh app profile | 7,143 ms | 1,738 ms | 3,920 ms | 102 ms |
| Reused profile, run 1 | 4,996 ms | 1,187 ms | 3,901 ms | 99 ms |
| Reused profile, run 2 | 5,057 ms | 1,163 ms | 3,951 ms | 97 ms |

Repeated total startup averages 5,027 ms before and 1,175 ms after. Desktop-to-authenticated-UI time remains approximately 1.1 seconds on repeated runs; the main measured saving is removal of the unchanged-source build. Windows caches were not flushed and the PC was not rebooted: the fresh profile is **not a reboot-cold measurement**. All six runs have no script errors and release their service locks. Updated shutdown waits 2.21–2.56 seconds for owned background probes to stop, rather than leaving those probes unawaited. Evidence: `startup-baseline.json`, `startup-updated.json` and their screenshots under the artifact directory above.

Physical GPU encoding, Linux/Docker deployment and actual phone pairing are not certified by these Windows checks. No live-site downloads, browser-cookie extraction, public exposure, release publication or GitHub push are part of this verification. Existing packaged binaries have not been rebuilt.

A read-only GitHub check confirms [v0.2.4](https://github.com/arkiental/media-workbench/releases/tag/v0.2.4), published 2026-10-05, has Windows installer and Linux AppImage assets. Its successful release workflow also has unexpired Windows/Linux artifacts. Those existing builds do not include this local reliability change; no assets were downloaded or published during this task.
