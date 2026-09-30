# Portable presets and compatibility

Schema1 stores declarative intent only: slug ID, revision, display name, required capability IDs, export options, optional maxHeight and logical action name. Registration uses a separate server UUID. Imports preserve the original JSON and migration explanations. Unknown keys/commands/paths/secrets are rejected rather than executed. Supported version0 fixtures migrate to schema1 with deterministic defaults; a legacy maximum byte count stays a hard ceiling.

Required unknown capabilities block import. An exact-cut requirement forces automatic selection to exact and rejects explicit copy. A byte ceiling cannot be weakened by applying the preset. Hardware preferences use only operational smoke-test results; software fallback occurs only when allowed. Logical action names grant no execution permission. Built-in templates are copied on import; user edits are independent. Version0 and1 are supported; newer required schemas are rejected clearly.

JSON example:

```json
{"schemaVersion":1,"id":"small-clip","revision":1,"name":"Small clip","requires":["target-size-v1","exact-cut-v1"],"options":{"cut":"exact","mode":"size","maxBytes":20000000,"codec":"h264","encoder":"hardware","allowSoftwareFallback":true}}
```

Source-time semantics: in inclusive, out exclusive, relative to the media's format timestamp origin. Crop coordinates refer to encoded source pixels before orientation; caption cues are intersected and retimed through kept segments. UI CSS changes do not alter these contracts.

Jobs retain `submittedRequest`, the effective request, `presetSnapshot.preset`, `presetSnapshot.original`, and the actual execution plan. Removing an imported preset does not remove historical intent or change a retry's hard constraints. A retry rechecks current host policy and source ownership. Repeating an already accepted idempotency key returns the original job even if its preset was subsequently removed.
