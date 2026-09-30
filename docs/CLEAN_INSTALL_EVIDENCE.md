# Clean source installation evidence

Verified on Windows x64 on 12 September 2026, using Node 22.23.2 and npm from its explicit local installation. `node tests/clean-install-smoke.mjs` created `test-output/clean-install-2oTJ5r` from an explicit source allowlist: 91 files, each recorded with SHA-256 in `snapshot.json`. It excluded root `node_modules`, `.tools`, `.data`, `dist`, `release`, `test-output`, secrets and Git metadata; it never recursively copied the repository into its own descendant.

The isolated directory completed the documented sequence:

1. `npm ci --no-audit --no-fund` installed 132 packages from `package-lock.json`; every direct runtime/development package was verified physically present in the isolated `node_modules`. npm may use its global integrity-checked download cache.
2. `npm run tools:setup` fetched pinned yt-dlp 2026.08.19 from its official release and checked its published SHA-256. Explicit `MW_FFMPEG`, `MW_FFPROBE` and `MW_NODE` paths supplied the known local FFmpeg/ffprobe 9.0.1 and Node runtime; setup copied and hashed them into the new `.tools` directory.
3. `npm run tools:verify` verified every staged binary hash.
4. `npm run build` passed TypeScript checks and built production server/web assets.
5. The staged Node launched the built headless backend on an ephemeral loopback port with PATH restricted to Windows System32. An authenticated capabilities request found the staged toolchain and a working libx264 encoder; an unauthenticated request returned 401.
6. The staged FFmpeg generated a real two-second numbered/pulsed fixture. HTTP upload and an exact export of `[0.3,1.3)` completed. The downloaded output measured **51,452 bytes**, decoded fully, and contained **ten frames whose decoded hashes exactly match source frames 3–12**. Its first rendered image was inspected and shows source timestamp `00:00:00.300` and frame number `3`.

Evidence: `test-output/clean-install-2oTJ5r/evidence.json`, `snapshot.json`, `commands.json`, numbered command logs, `service.log`, `clean-output.mp4` and `clean-output.png`. Commands omit credentials. The owned service was terminated after completed-output verification.

The first harness run installed/built successfully but omitted the required job idempotency header; that harness error was corrected and the entire fresh installation rerun. This verifies the source workflow with its documented Node/native-tool prerequisites. It does not claim a fresh operating-system installation, a cold global npm cache, Linux desktop behavior, or approved redistribution of the developer-supplied Windows tool binaries.
