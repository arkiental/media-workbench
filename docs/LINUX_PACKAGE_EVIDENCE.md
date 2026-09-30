# Linux package evidence

The subsequent rendered **Preview video** feature is also absent from this preserved archive; the current source and refreshed Windows package include it. See [rendered preview evidence](RENDERED_PREVIEW_EVIDENCE.md).

The later region-sidebar UI (layout B) is verified in the current source/browser and refreshed Windows package, but is **not included in this preserved Linux archive**. See [region editor evidence](REGION_EDITOR_EVIDENCE.md).

Verified 12 September 2026 at 05:43:53 UTC on Docker's Linux x64 engine. This report concerns the extracted **Debian 13 x64 package's headless backend**. Electron's graphical desktop was not launched.

Copies of this report inside an archive are packaging-time snapshots. The bundle's `provenance/linux-package.json` identifies its source/tool hashes; external `release/linux-package-evidence.json` and the final smoke evidence identify the final archive checksum and test result without a self-referential checksum.

**Final refresh is blocked.** The preserved archive and successful 05:43:53 UTC smoke below predate the final downloader diagnostic-redaction fix and newly added package documentation. The current builder includes the API/status/review/final-report/handoff documents, security/contributor/toolchain files and direct hashes for `download.ts`, `network.ts` and `storage.ts`; that updated archive was not exported or tested. The first refresh exhausted host disk and Docker returned RPC EOF before artifact export. Approximately 3.65 GB is free after separately authorized recovery; no new large build/copy started afterward.

Ordinary Docker start/restart could not initialize its Ingest server because `sailor-ingest.sock` could not be renamed to `.stale`. The bounded command `docker desktop stop --force --timeout 30` succeeded, and backend/UI/build processes were confirmed absent. The exact resolved runtime parent was a normal directory; native `FindFirstFileW` inspection identified a zero-byte socket with reparse tag `0x80000023`, the Windows AF_UNIX tag. No `.stale` file existed. The tag was interpreted using [Microsoft's reparse-tag documentation](https://learn.microsoft.com/nl-be/openspecs/windows_protocols/ms-fscc/c8e77b37-3909-4fe6-a4ea-2b9d423b1ee4).

Quarantining only that socket with `Rename-Item` failed with “The file cannot be accessed by the system.” Automatic approval review then rejected nonrecursive `Remove-Item` on the exact verified socket with **“blocked by policy.”** No alternate deletion API, reset, pruning, distro/VHD removal, or image/volume/cache/data deletion was attempted. No runtime socket mutation succeeded. Docker Desktop remains fully stopped. The precise attempts, remaining free space and preserved archive hash are recorded in `test-output/linux-package/recovery.json`.

Manual recovery: while Docker Desktop remains stopped, the user/administrator must quarantine or remove only `%LOCALAPPDATA%\Docker\run\sailor-ingest.sock`. If Windows still refuses access, obtain targeted Docker/Windows support rather than resetting Docker or removing its persistent data. Then run `docker desktop start` and confirm `docker info` succeeds. Preserve the verified archive before replacing it, confirm adequate disk headroom, and rerun the build/smoke commands below. Monitor C: during the work and stop below 0.8 GB free. Until that succeeds, the current source and the last tested Linux bundle must remain separate completion claims.

Artifacts:

- `release/Media Workbench-linux-x64/` contains Electron 44.3.0, the production application and the independent `run-headless` launcher.
- `release/media-workbench-linux-x64-debian13.tar.gz`: **269,842,317 bytes**, SHA-256 **`129c2639fde44dd216930dc97a68a3ca178735ff2db3c7e7f9328d29ebd4f0b1`**.
- `release/linux-package-evidence.json` records the archive, every native tool/library hash, tool origins and ten critical source-file hashes plus built server/web hashes. All ten source hashes matched the current repository after the final aggregate auxiliary-operation cap landed.

`scripts/package-linux.mjs` uses the existing pinned Docker toolchain. It packages Node 22.23.2, FFmpeg/ffprobe 9.0.1, yt-dlp 2026.08.19, 35 ELF dependency files, DejaVu Sans and CA certificates. Fixed executable wrappers set the packaged library, font and CA paths. It retains the verified official FFmpeg source/configuration, binary/source-package inventories, Debian copyright files and Node/yt-dlp licenses. The official Electron archive is checksum-verified by `@electron/get`; its SHA-256 is `8b49b9efdd73c0f467edc3c1cd5678392c384ccf224f34ff54179f736e2f384b` and its source URL is recorded in the manifest.

Build and verification commands:

```sh
docker build --target linux-artifact --output type=local,dest=release .
node tests/linux-package-smoke.mjs
```

The smoke test extracted the exact archive into a separate official Debian 13 slim image pinned to `sha256:d7e12182ce18b85b93007c1dedf31f2d29e01ccf3182cc4017c709b6259bc132`. The runtime had **no global Node, FFmpeg, ffprobe or DejaVu font**, and PATH was `/not-a-developer-path`. It ran as UID 1000 with a read-only root, no network, no capabilities, `no-new-privileges`, bounded CPU/memory/PIDs and explicit bounded data/tmp tmpfs mounts. The test verified all **45 packaged tool/library/font/certificate file hashes**, launched the bundled Node backend, authenticated, uploaded generated numbered media, and performed a real text edit with strict-size export.

The downloaded output measured **49,082 bytes**, **1.4 seconds**, with **14 actually decoded frame-hash records**, under a **60,000-byte maximum**. A full `-xerror` decode succeeded. Host ffprobe independently inspected the retrieved bytes. `packaged-output.png` was inspected and shows the requested “Linux bundled font” overlay and source timestamp `00:00:00.200`; no system font was available.

Evidence: `test-output/linux-package/evidence.json`, `build.log`, `service.log`, `packaged-output.mp4`, `packaged-output.png`; build command log `test-output/linux-container/package-linux-build.log`. The final runtime test image ID is `sha256:2ca8d79e2c67013e69322054fe26dbeb5fd334351ddcfee710529a637d1d8de2`. The owned test container was removed afterward.

A real initial failure caught root-owned `0700` directories inherited from the packager's temporary staging path. The builder now normalizes packaged directory traversal permissions to `0755` before creating the archive, and the non-root test passed afterward. Directly invoking a copied ELF loader was rejected as a packaging approach because it changed Node's `process.execPath` to the loader; the tested wrappers execute the real binaries with the Debian 13 system loader instead.

Support limits: this is a Debian 13/glibc 2.41 x64 personal local package, not universal Linux portability. The system kernel, ELF loader, shell and OS configuration remain required. Electron desktop requires normal graphical system dependencies and a display session; Linux window startup, clipboard, drag out and native integration are untested. ARM64, GPU passthrough, signing and public redistribution remain unverified or unapproved. The original application license does not replace bundled tools' licenses; complete corresponding source for every third-party dependency is not included. See `deploy/LINUX_PACKAGE_README.md` before use or redistribution.
