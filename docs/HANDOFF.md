# Release and platform handoff

The latest Windows UI also includes real rendered **Preview video**, verified through browser and packaged desktop playback. See [RENDERED_PREVIEW_EVIDENCE.md](RENDERED_PREVIEW_EVIDENCE.md). The pending Linux rebuild must include this change too.

The latest Windows package includes the verified region-sidebar layout B. Save any current work and reopen the app to load it. Browser and native proof, source paths and package hashes are in [REGION_EDITOR_EVIDENCE.md](REGION_EDITOR_EVIDENCE.md). Include this UI change as well as the diagnostic fix when eventually rebuilding the Linux archive.

The repository remains runnable with real integrations and validated media outputs. Read FINAL_REPORT.md and IMPLEMENTATION_STATUS.md before making a completion claim. The independent review found and drove fixes for actual frame loss, permission/idempotency/preset bypasses, quota races, implicit Docker volumes, worker cleanup, first-chunk rate bypass, missing lifecycle operations and lost native exit diagnostics. Its final reconciliation found no other demonstrated stable code gap; that is not certification of untested environments. The final Windows package is tested. The preserved Linux archive passed its own tests but predates the final diagnostic-redaction fix and package documentation; refreshing it is currently blocked by Docker startup.

## Start the verified build

On this prepared Windows workspace: `npm run desktop`, or `npm start` and pair at the local browser page. The Windows executable is `release/Media Workbench-win32-x64/media-workbench.exe`. Retain the whole package directory. The Linux archive is `release/media-workbench-linux-x64-debian13.tar.gz`; follow deploy/LINUX_PACKAGE_README.md for the bundled headless launcher and target requirements. `.data` and the desktop user-data directory are separate. Do not run two service owners against the same data directory.

## Remaining environment-dependent work

1. On an actual Debian13x64 graphical session, install the normal Electron system dependencies, launch the packaged GUI with sandboxing intact, and run the native desktop test against the real executable. Exercise reveal/SaveAs, file clipboard and drag recipients on each target X11/Wayland desktop. File clipboard/drag are currently marked unavailable there; implement and verify any chosen desktop adapter before enabling it.
2. On machines with supported GPUs, run real encoder smoke and export/validation for each advertised encoder, then repeat after driver/device changes. Verify strict no-fallback rejection and allowed software retry. Do not infer GPU decoding/filtering from GPU encoding.
3. Test actual browser-profile extraction with an explicitly selected test account/profile and the owner's permission. Verify success, locked/encrypted-profile failures, forget and temporary-file cleanup without disabling browser protections. Shared credential import remains disabled.
4. Test Windows native drag and compose attachment recipients without sending a message or uploading media. Choose applications where preparing an attachment does not itself transmit it. Test installed ShareX only with explicit upload authorization; capture a real completion/result integration before claiming upload success.
5. Before public hosting, follow SHARED_HOSTING.md on the real controller/Docker/TLS host. Run the independent worker/shared/egress/bandwidth suites, verify every writable mount and cleanup path, and confirm Host/Origin/Secure-cookie behavior over actual HTTPS. Production Linux-controller, rootless and public TLS configurations were not exercised here.
6. Before redistribution, complete the exact native-bundle corresponding-source/component-license audit, review the provisional name, and sign/test update artifacts using the publisher's credentials. Windows uses a local GPL-enabled Gyan FFmpeg build. Linux retains official FFmpeg source/configuration and dependency notices but does not include complete corresponding source for every component. No signed/public release was produced.

## Reproduction and evidence

- `npm test` runs deterministic/local checks. Docker, GUI, clipboard and live tests use explicit opt-in environment flags; see each test and its evidence report. A skipped default test is not passed.
- `npm run test:ui` uses installed Edge by default. It writes21-check browser evidence and actual edited files.
- `MW_TEST_DESKTOP=1`, `MW_DESKTOP_EXECUTABLE=<absolute package executable>`, `MW_RESTRICT_DESKTOP_PATH=1`, then `npx tsx --test tests/native-desktop.test.ts` tests the actual Windows package.
- `node tests/clean-install-smoke.mjs` verifies a fresh source snapshot without inherited dependencies/tools/data. It does not modify the source checkout.
- `docker build --target linux-artifact --output type=local,dest=release .`, then `node tests/linux-package-smoke.mjs` verifies the Linux archive's independent backend with no global tools.
- Keep the tools pinned unless intentionally testing an update. `npm run tools:update -- YYYY.MM.DD` and `npm run tools:rollback` are explicit local operations; rerun adapter/media tests before accepting new compatibility.

Source fixtures, reports and output media are retained under test-output. Disk exhaustion interrupted the last Linux refresh and one Windows native smoke. An initial recursive packaging-folder cleanup was rejected by automatic approval review with “blocked by policy.” A narrower cleanup was then accepted: exact duplicate archive/tool files were SHA-256 compared with preserved release/current-tool copies before removal from old staging directories. This restored about 3.6 GB; the staging directories themselves remain. The unchanged final Windows package then passed its full native smoke at 05:57:59 UTC. Its documentation links and server hash match the final source build.

## Exact Linux refresh blocker and next steps

Docker failed ordinary restart after disk recovery because it could not rename `C:\Users\Ark\AppData\Local\Docker\run\sailor-ingest.sock`. Docker was then stopped successfully with `docker desktop stop --force --timeout 30`; the backend and UI processes were absent. Read-only inspection verified the resolved parent is a normal directory and the exact zero-byte socket is a Microsoft AF_UNIX reparse point (tag `0x80000023`); no `.stale` socket was present. Quarantine via `Rename-Item` failed with “The file cannot be accessed by the system.” Automatic approval review then rejected nonrecursive removal of that exact verified socket with “blocked by policy.” No other removal API was used and runtime data was not changed.

1. With Docker Desktop still stopped, have the local operator repair or quarantine **only that stale IPC socket** through the operating system or Docker's supported recovery path. Do not reset Docker, delete its VHD/distro, or prune images/volumes as a substitute. This manual environment action remains outstanding.
2. Start Docker Desktop normally and confirm `docker info` succeeds. Check host free space before building; the preceding build exhausted the drive. Free additional space only by explicit operator choice if needed.
3. Run `docker build --target linux-artifact --output type=local,dest=release .`, then `node tests/linux-package-smoke.mjs`. The saved builder now includes final docs and directly hashes downloader/network/storage sources. Monitor free space and stop large writes before it falls below 800 MB.
4. Verify the new archive's hash/provenance, final diagnostic fix and bundled docs; require the isolated smoke's actual downloaded media, full decode and inspected PNG. Only then replace the blocked status in the ledger and reports.

The preserved verified archive is 269,842,317 bytes with SHA-256 `129c2639fde44dd216930dc97a68a3ca178735ff2db3c7e7f9328d29ebd4f0b1`. Exact recovery observations are in `test-output/linux-package/recovery.json` and LINUX_PACKAGE_EVIDENCE.md. No reset or cache prune was used.
