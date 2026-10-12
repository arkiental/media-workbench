# Optional public web mode

The current owner-only setup uses [private Tailscale access](PRIVATE_ACCESS.md). This document prepares a separate future hosting option; no public or invited-user service is active.

Media Workbench already has an authenticated shared-server mode: people open the browser UI on an HTTPS domain, pair with a separately issued credential, upload or download media, edit, and download completed exports. They do not install the desktop app. The local desktop and loopback-browser modes keep their existing behavior.

The prepared configuration is **invite-only**. There is no public registration route or anonymous download API. The owner creates a member or restricted guest in Settings > Administration and issues that user's pairing credential. Each credential is scoped and revocable. Do not give visitors the owner credential. Open registration would require account verification, account recovery, admission limits and abuse handling; it is not enabled by these templates.

No domain, DNS, firewall, tunnel, proxy, account grant or public listener was configured in this change. A deployment host, owned domain and access policy must be chosen before network setup. The Linux controller, its Docker isolation profile and the public TLS route still need verification on that host.

## Separate the hosted workspace

Use a dedicated service instance and a new private `MW_DATA_DIR`, such as `/var/lib/media-workbench-public`. Never point it at the desktop's Electron user-data directory or the local owner's existing `.data` directory. Do not mount the owner's media, browser profiles, credential folder or desktop action configuration into the hosting instance. The separate instance starts with an empty library; sharing desktop files requires an explicit upload.

The trusted controller runs the standalone server and administers Docker. The media worker image runs native media tools with selected read-only inputs, bounded scratch space, no direct network, dropped capabilities, and CPU, memory and process limits. Downloads use a mandatory per-operation filtering proxy. The runtime container described in `deploy/README.md` is a local headless distribution, not a complete shared controller; mounting a Docker socket into an ordinary media worker is not a deployment shortcut.

Start with [the existing shared-host instructions](SHARED_HOSTING.md). The additional templates are:

| File | Purpose |
| --- | --- |
| [public-web.env.example](../deploy/public-web.env.example) | Explicit shared mode, loopback listener, separate data path, disabled anonymous tunnel and empty required image/credential fields. The application does not automatically read this file. |
| [Caddyfile.public.example](../deploy/Caddyfile.public.example) | HTTPS domain proxy to loopback with a 256 MiB request-body ceiling. No data-directory file serving or catch-all hostname. |
| [public-member-policy.example.json](../deploy/public-member-policy.example.json) | Suggested small-host member limits; it is a policy payload template, not automatically applied configuration. |

Supply a strong owner credential through the deployment host's protected environment or secret store, outside the repository. Keep the example's image and credential fields empty until setup is explicitly approved. `MW_PUBLIC_ORIGIN` is a bare HTTPS origin; `MW_PUBLIC_HOST` is the matching hostname used by Caddy. Keep the application port private and forward the original Host. Do not disable the service's authentication, Host, Origin, or worker checks to make a proxy work.

The Caddy template uses documented [environment substitution](https://caddyserver.com/docs/caddyfile/concepts#environment-variables), [request-body limits](https://caddyserver.com/docs/caddyfile/directives/request_body), and [reverse proxy behavior](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy). Validate it with the installed Caddy version on the deployment host. DNS reachability and certificates remain hosting tasks. The proxy template has not been started here.

## Access and resource limits

The backend checks ownership on sources, artifacts, ranges, previews, projects, presets, jobs and events. The owner administers users and policy but cannot implicitly read a member's media. Shared mode denies host cookies, browser credential extraction, desktop paths, download destinations and executable/native actions, including for the hosted owner. API clients submit opaque object IDs and schema-checked media intent.

Sessions use Secure, HttpOnly, SameSite=Strict cookies, with exact public Origin checks. Shared mode trusts forwarded client addresses only from a loopback proxy, so pairing limits apply to separate visitors. Pairing allows 20 attempts per address per minute, tracks at most 4,096 addresses, and removes expired entries during requests at most once every ten seconds. New addresses receive 429 while that bounded table is full. The proxy must replace untrusted forwarded headers, and the controller port must remain private; do not place another proxy in front without checking that address chain. Local desktop/browser mode does not trust forwarded headers. Revoking the pairing credential invalidates the session backed by it. Credentials currently remain valid until revoked or their configured expiry; the browser UI does not provide self-service passwords or account recovery. Keep account administration private and issue separate credentials to separate people.

Each user has queue, concurrency, file-size, duration, pixel, CPU, memory, runtime, bandwidth, transfer, disk and retention limits. The member example allows 256 MiB inputs/outputs, 30-minute media, 1080p, eight pending jobs, one active job, five-minute job deadlines, 2 GiB managed storage, and 4 MiB/s API bandwidth. It permits software H.264 encoding only; other required encoders are rejected. Isolated scratch reserves three times the operation budget plus overhead, so the quota also covers active working copies. These limits constrain resource use; they do not guarantee that every permitted file completes within the deadline.

Before issuing the initial credential to an invitee, set that user's policy through Administration or the authenticated `PATCH /api/v1/admin/users/{id}` route, with `{"policy": ...}` containing the chosen complete policy. The example is not a grant and does not change any existing user. A restricted guest can download but cannot run editor processing; uploads and sites can be restricted further through policy. An empty `allowedSites` list permits public HTTP(S) sites within the network policy. A non-empty list limits submitted URL hosts and their subdomains; redirected/CDN resources still pass the private-address filtering boundary.

The durable job queue has a host-wide concurrency setting (1 by default, maximum 4), and auxiliary uploads/previews/inspection have a host cap of 4 and a per-user cap of 2. Per-user disk quotas do not replace deployment-host disk monitoring or limits on the number of admitted accounts. Originals are retained until explicitly deleted: the retention setting applies to eligible generated results, not automatically to every uploaded original. Provision enough disk for the invited population and stop admission before capacity is exhausted.

The download proxy checks every HTTP/CONNECT destination, resolves and pins public addresses, and denies loopback, private, link-local, reserved and metadata addresses. Redirects and nested manifests go through that same boundary. Initial URL validation alone does not provide worker isolation, so shared mode requires the verified image and mandatory proxy/relay configuration. Never enable the anonymous quick-tunnel prototype for a public shared instance.

## Verification and remaining hosting work

Requirement coverage: A16 (ownership), A17 (permissions/quotas), A18 (network/native boundaries), A20 (pairing/session), S10 (shared hosting). `tests/public-web-mode.test.ts` exercises the real shared controller's API hooks with isolated fixture storage. Its trusted worker adapter is replaced with a rejecting test runner so these controller tests neither start Docker nor download media; they do not prove OS/container isolation.

Run the focused controller test and the existing API/network tests from the source checkout:

```sh
npx tsx --test --test-concurrency=1 tests/public-web-mode.test.ts tests/security-api.test.ts tests/security-network.test.ts
```

Then run the opt-in real Docker isolation, shared media, redirect/nested-manifest and bandwidth tests listed in [SHARED_HOSTING.md](SHARED_HOSTING.md) on the selected host. Verify authenticated uploads, previews and exports as two invited users, including cross-user denial, revocation, queue/quota rejection, cancellation, interrupted-job recovery, actual HTTPS cookies, and public-origin enforcement. Confirm private app/Docker/data access from outside the proxy is unavailable. A missing deployment host or Docker/TLS test is unverified, not a passing production claim.
