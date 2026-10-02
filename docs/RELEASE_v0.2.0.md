# Media Workbench v0.2.0

Source prerelease for the local media downloader and editor.

## Changes

- Unified Library and Jobs, newest-first ordering, individual deletion and bulk selection/deletion.
- Import for local files and links, with inspected media details, thumbnails and format selection.
- Overlay, transform, audio and caption editing tools.
- Fast stream-copy trims when compatible; exact encoding remains available.
- Single-pass H.264/HEVC size targeting, audio/container budgeting and bounded correction. Oversized candidates skip full decode validation; published files still satisfy the byte ceiling and full-duration checks.
- Automatic hardware encoding and fast presets for new editor sessions. Local-owner processing can use all available CPU threads; isolated-worker limits remain enforced.
- Verified RTX 4090 H.264, HEVC and AV1 encoding with a compatible local FFmpeg build. GPU encoding does not imply GPU decoding or filtering.
- Native copy/reveal actions release the library file after creating the separate handoff copy. Deleting the library item preserves that copy until expiry. Startup clears legacy handoff locks without shortening copy lifetime.

## Validation

- Windows deterministic suite: 135 passed, 15 environment-dependent tests skipped before the final handoff fix; 18 targeted handoff/storage/transfer/lifecycle checks passed after that fix.
- GitHub Linux media checks passed on the feature commit containing the handoff fix.
- TypeScript and production build checked for the versioned release.
- Local 12-second 1080p, 2 MB export benchmark: 6.80 seconds originally, 4.99 seconds after the single-pass change, 2.37 seconds using RTX 4090 NVENC. One complete encoding pass remained under the size limit. These are local measurements, not universal performance guarantees.

## Build and limitations

Follow the root README: install Node >=22.23 and FFmpeg/ffprobe, then run `npm ci`, `npm run tools:setup`, `npm run tools:verify` and `npm run build`. Use `npm start` for the local web service or `npm run desktop` for Electron. `npm run package:desktop` produces an unsigned personal local package.

This release contains source only. No Windows/Linux binary bundle is attached: the bundled native tools' complete redistribution/source-license review remains unfinished. See THIRD_PARTY_NOTICES.md. Existing Linux desktop archives are not refreshed or published with this release. Platform-specific, Docker, live-site and native recipient checks require their documented environments; skipped checks are not claimed as passed.

Saved projects retain explicit encoder choices. Download filename/destination selection is not implemented; downloads enter Library. Shared hosting and HDR transforms retain their documented restrictions.
