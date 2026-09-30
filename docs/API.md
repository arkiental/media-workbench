# API v1

The service and typed schemas live independently of Electron and React. `packages/contracts/src/index.ts` defines runtime schemas and exported TypeScript types. Machine documentation is served at authenticated `GET /api/v1/openapi.json`.

Authenticate requests with `Authorization: Bearer <scoped token>` or exchange a token through `POST /api/v1/session {token}` for an HttpOnly SameSite=Strict cookie. Never put tokens in URL query strings. Host and Origin are checked even on loopback. Pairing scopes are `read`, `submit`, `manage`; a token cannot grant scopes it lacks. Every object lookup checks its owner. An opaque UUID is not permission.

| Method and path (prefix `/api/v1`) | Body / result |
|---|---|
| POST /session; DELETE /session | Pair with `{token}`; log out |
| GET /capabilities | Effective user policy, actually smoke-tested encoders, tool versions and native availability |
| GET /sources; GET /artifacts | Current user's source/artifact metadata |
| POST /uploads | Raw `application/octet-stream`; URI-encoded `x-filename`; returns managed Source after validation |
| POST /sources/inspect | DownloadRequest: `{url,preference?,format?,cookieId?,itemIndex?}`; bounded metadata/formats for up to100 entries; exactly one selected item (default1) |
| POST /jobs | JobRequest plus required `Idempotency-Key`; returns durable job at202 |
| GET /jobs; GET /jobs/:id | Per-user durable state and measured output artifact |
| POST /jobs/:id/cancel; POST /jobs/:id/retry | Cancel owned work; retry failed/cancelled/interrupted work from source |
| POST /jobs/reorder | `{ids:[UUID...]}`, own pending jobs only |
| POST /batches | `{items:[DownloadRequest...]}` plus Idempotency-Key |
| POST /batches/:id/cancel; POST /batches/:id/retry | Per-item cancellation or retry failed items |
| GET /history/export?format=json or csv | Current user's result report; CSV formula prefixes neutralized |
| GET /artifacts/:id/content | Authenticated single byte range; `?download=1` attachment |
| PATCH /artifacts/:id | `{pinned?,expiresAt?}` |
| GET /sources/:id/frames?around=seconds | Bounded actual presentation timestamp and keyframe index |
| GET /sources/:id/frame?pts=seconds | Source-decoded PNG; processing permission required |
| GET /sources/:id/waveform | Progressive peak envelope; optional start/duration (max60s)/points (max2000)/track; returns total duration, start/end, complete and sampling rate |
| POST /export/plan | `{recipe,options,presetId?}`; stream decisions, actual encoder, reasons and correction budget |
| GET /projects; POST /projects; DELETE /projects/:id | Save/load non-destructive source-time recipes; POST includes `{id?,name,recipe,options}` |
| POST /presets/validate; POST /presets/import | Portable preset directly; validated migration, original and change explanation |
| GET /presets; GET /presets/:id; DELETE /presets/:id | Registration records / portable export / delete |
| GET /settings; PATCH /settings | Owner changes `{concurrency}` between1 and4 |
| GET /cookies; POST /cookies/import | Owner-only metadata; `{name,content}` Netscape file, protected storage |
| POST /cookies/browser; DELETE /cookies/:id | Owner explicitly selects `{browser,profile?}`; forget |
| GET /pairings; POST /pairings; DELETE /pairings/:id | List/create `{name,scopes}`/revoke credentials |
| GET /admin/users; POST /admin/users | Owner list/create `{name,role}`; initial token returned only at creation |
| PATCH /admin/users/:id | Owner applies validated complete `{policy}` |
| POST /retention | Delete eligible expired managed files; preserve originals/dependencies/pins/leases |
| GET /events | Authenticated SSE snapshot, reconnect/poll for updated current-user jobs |
| GET /diagnostics | Sanitized tool/capability/failure report, no credentials/media/URL payloads |
| GET /desktop/artifacts/:id | Local owner AND secret companion header only; verified named local copy, original preserved, and one-hour renewable lease |

Submission forms: `{type:"download",download:{url}}`; `{type:"proxy",sourceId}`; `{type:"export",recipe:{schemaVersion:1,sourceId,segments:[{in:0.5,out:2}]},options:{cut:"exact",mode:"size",maxBytes:200000}}`. Runtime schemas fill defaults. Reusing a key with a different request fails; retrying an accepted identical key returns the same job even at queue capacity.

Future extension: keep credentials in the trusted background/service worker, restrict host permissions, pair with scoped and revocable tokens, and use HTTPS for any future remote service. Content scripts must never receive native authority or automatically relay site cookies. The full extension and companion registration are not implemented. Local post-actions belong to desktop IPC, not ordinary API submissions.

`DELETE /jobs/:id` removes only terminal job history; completed media remains. `DELETE /artifacts/:id` explicitly removes an owned managed file and its source registration while retaining history. Imported originals require `{confirmOriginal:true}`. Pinned, project-referenced, queued/active or leased artifacts cannot be deleted. No external source path is ever removed. New reads and leases are denied while explicit deletion runs. Policy errors are returned as structured `{error}` responses; the UI displays them. Auxiliary upload/preview/inspection is limited to two active operations per user and four across the host, with a whole-operation deadline.
