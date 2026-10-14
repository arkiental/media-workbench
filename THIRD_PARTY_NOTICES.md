# Third-party notices

The original Media Workbench application is licensed under MIT. Its complete license is retained as LICENSE in the source and resources/app/LICENSE in the Windows package.

## Windows portable package

The portable ZIP contains Electron 44.3.0, the official Node 22.23.2 Windows x64 runtime, the application's production npm dependencies, and Playfair Display. Components retain their original licenses.

- Electron's LICENSE and LICENSES.chromium.html remain at the package root. The latter includes Chromium and its bundled component notices.
- Node is extracted from the official node-v22.23.2-win-x64.zip and checked against the published SHASUMS256.txt. Its full license and checksum list are retained in resources/app/.tools/Node-LICENSE.txt and Node-SHASUMS256.txt. Source and release: https://nodejs.org/dist/v22.23.2/ .
- Production npm packages retain their license and notice files under resources/app/node_modules. Exact versions, npm artifact integrity records and retained notice filenames are listed in package-provenance.json. package-lock.json is also included. The supplemental abstract-logging notice is retained with that package.
- Playfair Display: Copyright 2017 The Playfair Project Authors. SIL Open Font License 1.1. Its license is retained in resources/app/dist/web/fonts/OFL-PlayfairDisplay.txt. Source: https://github.com/google/fonts/tree/main/ofl/playfairdisplay .

## Tools obtained on first launch

FFmpeg, ffprobe and yt-dlp executables are not included in the Windows portable ZIP. The launcher downloads them directly for the user's local installation, checks pinned SHA-256 records before use, and retains the resulting tool manifest under resources/app/.tools. The exact downloads and hashes are also recorded in portable-tools.json and the bootstrap source.

- FFmpeg and ffprobe: Gyan 8.0.1 full build, obtained from https://github.com/GyanD/codexffmpeg/releases/download/8.0.1/ffmpeg-8.0.1-full_build.7z . The archive's license and readme files are retained under resources/app/.tools/native-notices/ffmpeg. This build has separately licensed codec libraries and GPL features. FFmpeg licensing: https://ffmpeg.org/legal.html .
- yt-dlp 2026.08.19: obtained from https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.exe . The upstream project uses the Unlicense; the standalone executable's dependencies retain separate licenses. Upstream license information: https://github.com/yt-dlp/yt-dlp#license .

The portable ZIP's notices do not relicense subsequently downloaded tools. If distributing a folder after native setup, review the exact native binaries, component notices and corresponding-source requirements separately. The published ZIP excludes these executables and their local backups.

## Other build targets

Developer-supplied .tools binaries and Linux packages are separate compositions. The local setup manifest records their versions and origins; they are not inputs to the public Windows portable ZIP. Linux bundles retain their own component and source-distribution records. No font files are copied from the user's Windows installation.
