# Windows portable app

Extract the complete Windows x64 ZIP to a writable folder. Double-click **Start Media Workbench.cmd**. Do not run the application from inside the ZIP.

The first launch requires internet access. The launcher downloads the pinned official FFmpeg/ffprobe and yt-dlp releases, verifies their SHA-256 checksums, and installs them inside the extracted app folder. The download progress and any failure appear in the launch window. Retry the same launcher after correcting a connection problem; a failed setup does not open an incomplete app. Later launches reuse the verified local tools and can edit local files offline. Downloading media still requires internet access.

The ZIP includes Node, Electron and the application's production JavaScript dependencies. It does not require a separately installed Node, npm, FFmpeg or yt-dlp, administrator rights, or a system PATH change. Windows 10/11 x64 with the built-in `System32\tar.exe` is required. This release is unsigned. Keep the entire extracted folder together.

## Your workspace

Media, jobs and settings live in `data\media-service` beside the launcher; the desktop profile and service log live in `data\desktop`. These folders are created on use and are excluded from the release ZIP. Close the app before moving or backing up its folder. Closing the desktop stops its owned backend; interrupted work remains in history. The portable app does not install an autostart entry or modify an existing browser-server workspace.

The desktop pairs automatically with its own loopback backend. No access-token entry is needed in its window. Existing private Tailscale routes and credentials are not imported or changed.

## Editing and export

Import a file or inspect a link, then open a ready file from Library. Simple cuts use fast stream copy when compatible; their boundaries expand to usable keyframes. Choose Exact frame cut when precise edges matter. Transforms, captions, audio changes and compression can require rendering. Review export shows the plan before starting. Fully verify lossless exports adds full decoded-frame comparison and is slower.

Hardware encoders are tested on the current PC. Their availability depends on the GPU and driver; permitted software fallback remains available. This Windows release does not certify Linux desktop operation or every codec/driver combination.

## Release integrity and notices

Compare the ZIP against its accompanying SHA-256 file before extraction. `package-provenance.json` records the source commit, runtime versions, dependencies and packaged file hashes. Retained licenses are in `Media-Workbench-LICENSE.txt`, `THIRD_PARTY_NOTICES.md`, Electron's `LICENSE` and `LICENSES.chromium.html`, and the Node/dependency notices under `resources\app`. The separately downloaded native tools retain their own licenses and notices.

Official tool downloads used by first launch:

- [Gyan FFmpeg 8.0.1](https://github.com/GyanD/codexffmpeg/releases/tag/8.0.1)
- [yt-dlp 2026.08.19](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19)

The ZIP excludes those native executables; first launch downloads them directly for local use. An offline first launch is unsupported.
