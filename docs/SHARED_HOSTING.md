# Authenticated shared hosting

Shared mode is implemented and has passed synthetic Windows-controller/Linux-worker integration and independent isolation tests. No public endpoint, real certificate, production Linux controller, or rootless Docker deployment has been tested in this session. Run the same isolation tests on the deployment host before admitting users. A working local container alone does not establish shared-worker isolation.

The trusted controller owns the database and Docker orchestration. It must run from this source/build directory with a private data directory, an explicit owner credential, Docker CLI access, and the pinned runtime image. Docker access is privileged administration; never expose its socket or CLI through the renderer, API, reverse proxy, or user containers. The native media worker runs as UID 1000 with no network, a read-only root, dropped capabilities, no-new-privileges, PID/CPU/memory limits and only individually selected read-only inputs. No container image may declare implicit writable volumes. Worker images are resolved to immutable IDs at startup.

Build and verify locally, before configuring a public listener:

```powershell
npm ci
npm run tools:setup
npm run build
docker build --target runtime -t media-workbench:local .
$env:MW_TEST_ISOLATION='1'
$env:MW_TEST_SHARED='1'
$env:MW_TEST_DOCKER_EGRESS='1'
npx tsx --test --test-concurrency=1 tests/worker-isolation.test.ts tests/security-worker.test.ts tests/shared-isolation.test.ts tests/security-shared.test.ts tests/egress-isolation.test.ts tests/security-bandwidth.test.ts
```

For a Linux controller, use the equivalent shell exports after installing the documented Node/tool prerequisites. That controller/platform combination remains a deployment verification task. Keep the image and the source used for proxy/relay scripts under administrator control. The service refuses shared startup without all required settings:

```powershell
$env:MW_SHARED='1'
$env:MW_WORKER_IMAGE='media-workbench:local'
$env:MW_PUBLIC_ORIGIN='https://workbench.example.com'
$env:MW_HOST='127.0.0.1'
$env:MW_PORT='4319'
$env:MW_DATA_DIR='C:\MediaWorkbench-private\data'
# Set MW_OWNER_TOKEN through a protected environment/secret store to a fresh
# random credential with at least 32 random bytes. Do not paste it in a URL.
npm start
```

Keep port 4319 reachable only by the local proxy. Configure the owned domain and TLS on the proxy; [Caddyfile.example](../deploy/Caddyfile.example) forwards HTTP over loopback and retains the external Host header. Caddy obtains and renews certificates when its public DNS/reachability prerequisites are met; see the official [HTTPS quick start](https://caddyserver.com/docs/quick-starts/https) and [reverse proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy). This configuration has not been deployed publicly here. Do not disable certificate checking or the application's Host/Origin checks. A tunnel does not replace them. Pair through the HTTPS UI; the session cookie is Secure, HttpOnly and SameSite=Strict. Create separate member/guest users and revocable scoped credentials in Administration.

Each downloader invocation gets a dedicated socket proxy. The untrusted worker has no external TCP/DNS route and a read-only mount of that socket. The proxy revalidates every HTTP destination/CONNECT tunnel against resolved public addresses, pins the resolved address, and rejects private, loopback, link-local, reserved and metadata destinations. Redirects and nested manifests cannot bypass it. Its Transform streams enforce first-chunk bandwidth and total transfer limits in both directions, including TLS. API transfers share a per-user aggregate bandwidth schedule; each separate downloader invocation has its own configured transfer/rate budget. Concurrency limits bound their aggregate. Shared mode cannot import the owner's cookies or configure/run native actions, even with the owner's credential and a desktop secret.

Scratch storage uses a named tmpfs with a kernel byte/inode ceiling. The controller reserves three times `(operation byte budget + 8 MiB)` per user for the bounded volume, host working files and validated copyback staging. Concurrent previews, uploads and jobs compete for the same available storage. Reservations remain held through cleanup. A smaller remaining quota reduces the operation budget or rejects the operation before work begins. Auxiliary previews/uploads/inspection have one whole-operation deadline (maximum 120 seconds); job deadlines cover all passes, validation and helper preparation. Timeout or cancellation removes owned containers and volumes. After a crash, startup removes only resources carrying this data directory's owner label and marks active jobs interrupted. `/tmp` is an additional private 256 MiB memory filesystem required by yt-dlp's packaged runtime; helper memory/CPU have separate small fixed ceilings. These are containment ceilings, not promises that every maximum-sized input fits in memory.

Roles enforce input/output bytes, duration, pixels, codecs, encoder allowlists, processing permissions, queued/active counts and retention. Codec lists apply to every audio/video stream, so include `aac` alongside `h264` when permitting both. Empty lists mean unrestricted within other policy. CPU and memory are hard container limits in isolated mode; ordinary trusted local mode does not claim an OS sandbox. Retention runs only on eligible app-managed outputs and never deletes imported originals automatically. Pin dependencies or extend expiry for long-lived results. Back up the private data directory while the service is stopped.

Rootless Docker can reduce daemon privilege, but is untested with this tmpfs-volume profile; validate its cgroup/filesystem behavior before using it. Consult the official [Docker security](https://docs.docker.com/engine/security/) and [rootless prerequisites](https://docs.docker.com/engine/security/rootless/) rather than granting arbitrary access to the daemon. See [independent review](INDEPENDENT_REVIEW.md), [egress evidence](EGRESS_EVIDENCE.md), and [implementation ledger](IMPLEMENTATION_STATUS.md) for the tested scope and remaining release blockers.
