# Local Linux headless distribution

Build from a clean checkout with Docker:

```sh
docker build --target runtime -t media-workbench:local .
docker volume create media-workbench-data
docker run --rm --init --name media-workbench --network host \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 128 --memory 2g --cpus 2 \
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=256m \
  --mount source=media-workbench-data,target=/data \
  media-workbench:local
```

On a native Linux Docker host, `--network host` lets the service bind **host loopback only**, so the local browser can open `http://127.0.0.1:4319`. It does not enable shared hosting. Obtain the initial pairing token through `docker exec media-workbench cat /data/owner-token`; handle it as a secret. Alternatively supply a strong `MW_OWNER_TOKEN` through a protected environment file. The service runs as UID 1000 and writes only its managed data volume and temporary files. Imported user media must be uploaded through the authenticated API/browser; no host filesystem is mounted by default.

Docker Desktop needs its optional host-network support for this local browser arrangement. The automated smoke test instead makes authenticated requests inside the Linux container and copies completed artifacts out for independent probing. Neither mode proves Linux clipboard or desktop integration. This local container is not the shared controller. For opt-in shared orchestration and reverse-proxy/TLS setup, see [shared hosting](../docs/SHARED_HOSTING.md); its additional isolation profile must pass on the deployment host.

The production image contains only production Node dependencies and the built server/web assets. Electron is absent. FFmpeg **9.0.1 is built from the official release source**, with its pinned SHA-256 and PGP signature checked against the published release-key fingerprint. Its codec/font dependencies come from a dated Debian snapshot using signed metadata and package integrity checks. Debian's FFmpeg 7.1.5 binaries are replaced by the source build: version 7 loses frame-rate metadata during `setpts`, which caused a last-frame decoding failure in our exact-cut tests. yt-dlp 2026.08.19 official Linux executable hashes are committed in `install-ytdlp.mjs`; Node 22.23.2 uses an immutable official-image digest. yt-dlp's packaged Python runtime extracts shared libraries into `/tmp`, which therefore must explicitly use `exec`; it remains a size-bounded private container tmpfs. AMD64 is the tested architecture; ARM64 configuration is untested.

Run `node tests/linux-container-smoke.mjs` for build, non-root/read-only startup, authenticated import/export, actual output decoding, and cleanup evidence. Run `docker build --target test -t media-workbench:test .` followed by `docker run --rm --init --network none --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --memory 3g media-workbench:test` for native Linux media/process tests.

This is a reproducible local build recipe, not a signed or published container release. Installed dependency versions/source-package names are recorded at `/usr/local/share/media-workbench/debian-packages.tsv`, and each package retains copyright/license text under `/usr/share/doc`. The exact FFmpeg source tarball, `config.h`, `config.mak`, tool version and binary hashes are retained under `/usr/local/share/media-workbench`; `ffmpeg-version.txt` identifies the replacement binaries rather than the bootstrap Debian package version. FFmpeg is built with GPL features, and its libraries retain their own source-distribution obligations. Review exact image contents and corresponding-source availability before redistributing; the original application's license does not relicense bundled tools. Debian source versions can be retrieved from the matching [dated archive](https://snapshot.debian.org/). The [official FFmpeg release](https://ffmpeg.org/download.html), [official Node image](https://github.com/nodejs/docker-node) and [yt-dlp release](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19) retain their notices.
