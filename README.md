# Media Workbench

A local-first media downloader and single-source clip editor. The name is provisional. The implementation has real yt-dlp, FFmpeg and ffprobe execution, SQLite jobs, a React browser interface and an Electron desktop shell. See [implementation evidence](docs/IMPLEMENTATION_STATUS.md) and [independent review](docs/INDEPENDENT_REVIEW.md) for exactly what is verified. This is a development build, not a completed public stable release.

The current source UI uses **Library / Editor / Jobs**, with **Add media** for imports and URLs. The editor has a vertical tool rail, selectable canvas titles, a contextual inspector, and Text / Video / Audio timeline tracks. Text styles persist and render in actual exports. **Export…** opens the reviewed export flow; **Render preview** is in the viewer's More menu. Cut and Project are in the tool rail's More menu. Saved projects are in Library. Appearance, presets, integrations and administration are under Settings. Valid drafts recover on navigation/reload within the same browser origin; save a named project to pin its source dependencies. See the [contextual editor changes, critic review, and validation](docs/CONTEXTUAL_EDITOR_RESULTS.md). Existing release binaries must be rebuilt to receive this UI.

## Run on Windows

Prerequisites: Node 22.23 or newer, npm, and an explicitly installed FFmpeg/ffprobe build. The tested environment uses Node22.23.2 and FFmpeg9.0.1. Git is optional for a downloaded source checkout.

```powershell
npm ci
npm run tools:setup
npm run tools:verify
npm run build
npm start
```

Open `http://127.0.0.1:4319` in a browser. Read the access token from `.data/owner-token` and paste it into the pairing screen. The token is shown only once through the local file, never embedded in a URL. Keep the data directory private. Local use needs no cloud account, subscription, telemetry, or API key.

For the desktop app, run `npm run desktop` after building. It launches its own loopback service with an ephemeral port, a private credential and the staged Node runtime. Closing it gracefully cancels work; interrupted jobs remain in history. The desktop uses Electron's user-data directory, separate from the default headless `.data` directory. A second desktop launch focuses the first instance. There is no tray/background mode.

Paste URLs and inspect formats before submitting; select a specific video from a multi-video post; one selected item per URL is the safe default. Batches run sequentially unless the owner changes concurrency. Drop or choose local files to upload managed immutable copies. Use the editor to select source-time segments, crop encoded source pixels, rotate/resize, add timed text/captions, choose audio edits and review the export plan. Strict size limits are integer bytes (MB=1,000,000; MiB=1,048,576). The output either fully validates within the limit or fails explicitly. Copy, download, reveal, and configured desktop handoffs operate on completed artifacts.

Browser users download files. Windows desktop copy-file creates native file-transfer clipboard data; copy-path is a different command. External actions require local executable registration and confirmation; upload handoffs are not reported as upload success. Shared-host cookies, native visitor actions, and hybrid smart cutting are disabled.

## Development and verification

```powershell
npm run fixtures
npm test
npm run test:ui
npm run package:desktop
```

`test:ui` uses installed Microsoft Edge by default; set `MW_BROWSER_CHANNEL` to a Playwright-supported installed channel if needed. The test imports generated numbered media, plays the original, steps an indexed frame, exports, downloads and plays the output. Real output evidence is kept in `test-output/`. Tests never send live messages or upload to third-party workflows. The desktop package in `release/` is an unsigned personal local build; read third-party notices before redistribution.

Tool setup pins yt-dlp to the tracked release in `toolchain.lock.json`, verifies the official release checksum, copies explicitly installed FFmpeg/ffprobe/Node, and writes local SHA256 provenance. Set `MW_FFMPEG`, `MW_FFPROBE` or `MW_NODE` to explicit executable paths before setup when required. `npm run tools:update -- YYYY.MM.DD` stages an explicit yt-dlp release; run the integration suite before accepting compatibility. `npm run tools:rollback` restores the previous verified binary. No remote user or preset can configure tool URLs or flags.

Environment: `MW_DATA_DIR`, `MW_PORT`, `MW_HOST` (loopback by default), `MW_OWNER_TOKEN` (explicit bootstrap), `MW_FFMPEG`, `MW_FFPROBE`, `MW_YTDLP`. Shared mode additionally requires `MW_SHARED=1`, a built `MW_WORKER_IMAGE`, explicit owner credential and HTTPS `MW_PUBLIC_ORIGIN`. It runs native work in isolated Linux containers with mandatory filtered egress. Read the [shared deployment instructions and tested limits](docs/SHARED_HOSTING.md) before network exposure; no public deployment or TLS endpoint was tested here.

Built artifacts: `release/Media Workbench-win32-x64/media-workbench.exe` and `release/media-workbench-linux-x64-debian13.tar.gz`. The Windows package was tested with a restricted PATH. The Linux archive's headless backend passed on minimal Debian13x64 without global tools; its Electron GUI remains untested. See [Linux package instructions](deploy/LINUX_PACKAGE_README.md), [verification report](docs/FINAL_REPORT.md), and [release handoff](docs/HANDOFF.md).

See [API](docs/API.md), [architecture](docs/ARCHITECTURE.md), [threat model](docs/THREAT_MODEL.md), [preset migrations](docs/PRESETS.md), [third-party notices](THIRD_PARTY_NOTICES.md), [security reporting](SECURITY.md), and [contributing](CONTRIBUTING.md).
