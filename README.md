# Media Workbench

A local-first media downloader and single-source clip editor. The name is provisional. The implementation has real yt-dlp, FFmpeg and ffprobe execution, SQLite jobs, a React browser interface and an Electron desktop shell. See [implementation evidence](docs/IMPLEMENTATION_STATUS.md) and [independent review](docs/INDEPENDENT_REVIEW.md) for exactly what is verified. This is a development build, not a completed public stable release.

The UI combines files and jobs in **Library**, newest first, with selection and bulk deletion. **Import** accepts local files and links; the link flow shows inspected media and available formats before download. **Editor** provides cutting, overlays, transforms, audio and captions. **Review export** opens the reviewed export flow; **Render preview** creates a playable file with the current edits. Saved projects are in Library. Valid drafts recover within the same browser origin; save a named project to pin its source dependencies. Copying or revealing a file no longer leaves the library item locked: the separate handoff copy remains available until its expiry.

New editing sessions use **Cutting → Fast when possible**: simple trims copy compressed streams and can join kept sections without encoding. Existing saved export choices are preserved; select this mode to switch an older draft to fast trimming. Cuts expand to keyframes; choose **Exact frame cut** for precise edges. Filters, compression targets and incompatible MP4 streams still require encoding. Fast copies check streams, duration and short decodes at the cut edges. Enable **Fully verify lossless exports (slower)** in Review export for full decoded-frame comparison and output decoding. See [fast trim evidence](docs/FAST_TRIM.md).

## Run on Windows

Desktop imports default to 20 GiB per file and 24 hours of media, with 100 GiB of managed storage; custom limits are preserved. Local imports report upload progress and check metadata and short beginning/end decodes instead of decoding the entire file. Downloads allow an editable filename and a native destination-folder picker; an additional managed copy stays in Library and existing destination files are never overwritten. Right-click text fields for Paste. See [v0.2.1 changes and validation](docs/RELEASE_v0.2.1.md).

Maximum-size exports allocate the byte budget to container overhead, audio and video before encoding. H.264/HEVC use a single encoding pass with a bounded bitrate buffer instead of mandatory two-pass rendering. A completed candidate is checked against the exact byte ceiling before full decode validation; an oversized candidate may use the configured bounded correction attempts. The final file retains its full duration, and impossible limits fail without publishing. Quality/bitrate exports keep their existing settings. Run `npx tsx scripts/benchmark-size.ts current` for a repeatable 12-second 1080p motion benchmark (results in `test-output/size-benchmark`).

New editor sessions default to automatic hardware encoding and the fast preset. Legacy source drafts adopt these defaults once; saved projects and subsequent explicit encoder choices are preserved. Local-owner exports use the machine's available CPU threads for decoding, filters and software encoding; isolated workers retain their CPU policy. NVIDIA uses NVENC presets P1/P4/P7 for fast/balanced/quality with multipass disabled, and max-size mode caps bitrate bursts. A real hardware smoke test runs for the requested codec before each export, with policy-controlled software fallback. GPU encoding leaves filters and decoding on the CPU. The current Windows tool bundle uses FFmpeg 8.0.1 to support the installed RTX 4090 driver; the prior FFmpeg 9 build required an unavailable NVENC API. Use `npx tsx scripts/benchmark-size.ts gpu-fast auto fast` to measure the complete GPU export, including checks.

Prerequisites: Node 22.23 or newer, npm, and an explicitly installed FFmpeg/ffprobe build. The current Windows environment uses Node 22.23.2 and FFmpeg 8.0.1. Git is optional for a downloaded source checkout. The v0.2.0 prerelease distributes source; native tools and the unsigned local desktop package are not included.

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
npm run test:responsive
npm run package:desktop
```

`test:ui` uses installed Microsoft Edge by default; set `MW_BROWSER_CHANNEL` to a Playwright-supported installed channel if needed. The test imports generated numbered media, plays the original, steps an indexed frame, exports, downloads and plays the output. Real output evidence is kept in `test-output/`. Tests never send live messages or upload to third-party workflows. The desktop package in `release/` is an unsigned personal local build; read third-party notices before redistribution.

Tool setup pins yt-dlp to the tracked release in `toolchain.lock.json`, verifies the official release checksum, copies explicitly installed FFmpeg/ffprobe/Node, and writes local SHA256 provenance. Set `MW_FFMPEG`, `MW_FFPROBE` or `MW_NODE` to explicit executable paths before setup when required. `npm run tools:update -- YYYY.MM.DD` stages an explicit yt-dlp release; run the integration suite before accepting compatibility. `npm run tools:rollback` restores the previous verified binary. No remote user or preset can configure tool URLs or flags.

Environment: `MW_DATA_DIR`, `MW_PORT`, `MW_HOST` (loopback by default), `MW_OWNER_TOKEN` (explicit bootstrap), `MW_FFMPEG`, `MW_FFPROBE`, `MW_YTDLP`. Shared mode additionally requires `MW_SHARED=1`, a built `MW_WORKER_IMAGE`, explicit owner credential and HTTPS `MW_PUBLIC_ORIGIN`. It runs native work in isolated Linux containers with mandatory filtered egress. Read the [shared deployment instructions and tested limits](docs/SHARED_HOSTING.md) before network exposure; no public deployment or TLS endpoint was tested here.

Built artifacts: `release/Media Workbench-win32-x64/media-workbench.exe` and `release/media-workbench-linux-x64-debian13.tar.gz`. The Windows package was tested with a restricted PATH. The Linux archive's headless backend passed on minimal Debian13x64 without global tools; its Electron GUI remains untested. See [Linux package instructions](deploy/LINUX_PACKAGE_README.md), [verification report](docs/FINAL_REPORT.md), and [release handoff](docs/HANDOFF.md).

See [API](docs/API.md), [architecture](docs/ARCHITECTURE.md), [threat model](docs/THREAT_MODEL.md), [preset migrations](docs/PRESETS.md), [third-party notices](THIRD_PARTY_NOTICES.md), [security reporting](SECURITY.md), and [contributing](CONTRIBUTING.md).
