# Media Workbench v0.2.1

Source prerelease fixing desktop imports, downloads and editing.

## Changes

- Right-click editable fields, including the download URL, for native Paste, Copy, Cut and Select All.
- Edit the download filename and choose a destination folder in the desktop app. A managed copy stays in Library. Existing filenames receive a numbered suffix instead of being overwritten.
- Desktop-owner import defaults increase to 20 GiB per file, 24 hours of media and 100 GiB of managed storage. Existing custom limits are preserved.
- Local desktop imports stream without the network bandwidth throttle, report upload progress and use metadata plus short beginning/end decode checks instead of decoding the entire video. Interrupted transfers terminate cleanly. Shared-service limits and full output validation remain enforced.
- Long-video previews use bounded HTTP ranges, and ordinary timeline scrubbing no longer waits for frame-index scans. Explicit frame inspection remains available.
- Caption size and padding accept intermediate typing states, commit on Enter or blur, and restore the previous value on Escape.

## Validation

- Production TypeScript/build validation and regression tests for download naming, authorized folder selection, existing-file preservation, import checks and large-file preview ranges.
- Browser test imports a generated 2-hour-5-minute video, seeks near its end, types caption size 64 and checks filename/folder submission. Local import measured approximately 1.4 seconds for this small, low-frame-rate fixture; this is not a multi-gigabyte copy benchmark.
- Desktop test exercises right-click menu roles and the real preload/IPC/paired-service folder registration, with the operating-system folder dialog stubbed.
- A sparse 3 GiB transfer fixture verifies bounded preview requests and end-of-file seeking separately from media decoding.

## Build and limitations

Follow the root README for build instructions. The Windows desktop package is rebuilt locally as an unsigned personal build. This GitHub prerelease contains source and checksums only; bundled native-tool redistribution/source-license review remains unfinished (see THIRD_PARTY_NOTICES.md).

Folder selection requires the desktop app. Browser downloads stay in Library and can be saved with Download file. Local import sampling does not detect corruption in every frame; export validation remains unchanged. Unplayable source codecs still require a playback copy.
