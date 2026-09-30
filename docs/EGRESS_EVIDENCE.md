# Mandatory worker egress proof

Verified on 2026-09-12 using Docker Desktop's Linux engine and image `media-workbench:local`. This is a mechanism and integration-test report. The service must actually select this worker profile before it can claim isolation; merely including these scripts does not make an unsandboxed downloader safe.

## Architecture and invocation

Each downloader runs with Docker `--network none`. It has no default route and only its own loopback interface. A separate, unprivileged proxy sidecar has normal network access but no published ports, Docker socket, user media, or service database. Its HTTP proxy listens on `/proxy/egress.sock` in a unique named volume. That volume is mounted **read-only** in the worker and read/write in the sidecar.

`deploy/egress/proxy.mjs` is the production proxy entry point. It reads `MW_PROXY_SOCKET` (default `/proxy/egress.sock`) and `MW_PROXY_MAX_BYTES`. Its `ipaddr.js` dependency resolves from the image's `/app/package.json`. It validates HTTP(S) schemes, ports, credentials, every DNS result, and private/reserved IPv4/IPv6 addresses; upstream connections use the validated numeric address. Redirects and nested downloads cause new proxy requests and repeat the check. CONNECT cannot name a private destination. Aggregate transfer bytes, sockets, header size, request times, and connection concurrency are bounded.

`deploy/egress/relay.mjs` runs inside the network-less worker:

```text
/usr/local/bin/node /proof/relay.mjs --socket /proxy/egress.sock -- /usr/local/bin/yt-dlp [existing validated arguments]
```

The relay opens a loopback TCP listener and transports its bytes to the Unix socket. It replaces the existing yt-dlp `--proxy` argument (or inserts one before the URL separator), clears `NO_PROXY`, and launches a real executable with a separate argument array. A compromised downloader can ignore proxy settings, but its own network namespace has no external route.

The worker and sidecar use a read-only root filesystem, a non-root image user, dropped capabilities, `no-new-privileges`, CPU/memory/PID limits, and bounded temporary storage. This image contains a PyInstaller one-file yt-dlp, which extracts native libraries before running. An initial 32 MiB/noexec temporary mount failed in the real download test. The verified profile uses a per-job 256 MiB `/tmp` tmpfs with `exec,nosuid,nodev` and a 512 MiB worker memory limit. A future pre-extracted or Python package distribution can remove the executable temporary-directory need. Do not silently restore `noexec` and assume the tool still runs.

## Observed tests

Run `MW_TEST_DOCKER_EGRESS=1 npx tsx --test tests/egress-isolation.test.ts` after building `media-workbench:local` and generating fixtures. `MW_WORKER_IMAGE` can select a reviewed image tag. The test creates unique containers/volume and removes them on completion or failure.

The latest passing proof includes:

- 25 independent network/socket observations. Raw worker connections to public IPv4/IPv6, host/gateway ranges, cloud metadata, and the proxy fixture's loopback listener failed with `ENETUNREACH` or `ECONNREFUSED`. Direct external DNS failed. `/proc/net/route` had no default route; `/proc/net/dev` showed only loopback.
- Proxy HTTP requests to private, loopback, link-local, IPv6 ULA, IPv4-mapped IPv6, and `localhost` received HTTP 403. Private CONNECT destinations also received 403.
- The worker could connect to the Unix socket through its read-only volume but could not create a file on that volume.
- Actual yt-dlp downloaded the controlled numbered-video fixture through the relay and socket proxy: **250,096 bytes**, SHA-256 `abcb19b59596a83c66b4801b92a65e1992f33268bfd7fb558d1c94630c8d8ecb`, byte-identical to the source. A second network-less container fully decoded the resulting file with real FFmpeg.
- Actual yt-dlp requests following a redirect to cloud metadata and an HLS segment URL pointing at cloud metadata failed. The proxy independently recorded a denied request for each scenario. The HLS final diagnostic was “downloaded file is empty”; checking only its final text would not establish the rejection, so the test also checks the proxy's observed denial count.

Artifacts and exact commands/results are retained under `test-output/egress/<run-id>/evidence.json`, `socket-proof.json`, and `verified.mp4`. Failures retain `failure.json`. The `proof-sidecar.mjs` and `proof-worker.mjs` files are deterministic test helpers and must not be selected by production service code.

## Service worker filesystem and lifecycle

`apps/server/src/worker.ts` integrates the socket proxy with actual per-invocation native workers. Each invocation stages managed work into a Docker local-driver **tmpfs** volume with a kernel byte limit of `ctx.maxBytes + 8 MiB`, a finite inode limit, UID/GID 1000, and `nosuid,nodev,noexec`. `/tmp` is separately bounded for yt-dlp extraction. Native workers receive individual selected inputs as read-only binds; there is no writable host-directory bind. A named, owner-labelled, network-less scratch helper keeps the tmpfs mounted across staging, execution, validation and copyback. Only this fixed trusted helper has CHOWN/DAC_OVERRIDE to set staged ownership; the native media process retains no capabilities. `volume-nocopy` is required because Docker otherwise resets ownership when mounting an empty volume from the image.

After successful execution, the helper enumerates the scratch tree and rejects symlinks, special files, hard links, unsafe names, excessive entries or bytes before any host copyback. The host repeats regular-file and size checks on temporary staging. Failed or cancelled native calls do not copy their scratch output back. Containers and volumes are named, labelled, bounded by timeouts, and removed on completion, cancellation or owner recovery. Images that declare implicit writable Docker volumes are rejected before creating a context; the former Dockerfile `/data` volume was removed after independent review identified it as a quota escape.

`MW_TEST_ISOLATION=1 npx tsx --test tests/worker-isolation.test.ts` passed against image `sha256:5bc50972afb76a1f8391004a215dff6be452b98a0742cfff340aa26d0fa66466`. Its real export retained all ten expected source-frame hashes from 0.3 to 1.3 seconds and fully decoded. Evidence: `test-output/worker-4ex5hf/evidence.json` and `work/export.mp4`. Independent `tests/security-worker.test.ts` also passed all four cases: inspected running native mount/resource restrictions, failed `/data` write, cancellation during native work and proxy preparation with zero owned containers/volumes or host copyback left behind, a 16 MiB write rejected against a 1 KiB budget plus bounded overhead, and fail-closed rejection of a synthetic image declaring an unexpected writable volume. Evidence includes `test-output/review/worker-lnnJey/evidence.json` and `worker-preparation-Cqiai1/evidence.json`.

## Limits of the evidence

The fixture origin is an explicit test-only exception inside the proxy sidecar; it cannot be reached through a worker raw socket. The production executable does not read or enable that exception from an environment variable. Public live-site extractor observations are separately recorded in `SITE_SUPPORT.md` and do not establish shared-container public deployment. Docker-host administration, kernel escape resistance, image provenance, service authorization, and public reverse-proxy deployment still require their own review and tests.
