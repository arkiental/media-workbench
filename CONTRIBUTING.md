# Contributing

Read PROJECT_SPEC.md, AGENT_BUILD_PROMPT.md and the implementation ledger before changing scope. Keep media execution independent of Electron/React. Use runtime schemas and argument arrays; never accept portable commands or machine paths. Generate fixtures rather than committing personal media, credentials or copyrighted test downloads.

Run `npm ci`, `npm run build`, `npm test`, and applicable real browser/native tests. Tests must inspect outputs, not merely exit status. Include requirement IDs, validation commands, observed evidence, and platform limits in changes. A missing OS/GPU/site is untested. Security and media correctness take priority over appearance. Original contributions are MIT; review external-code licenses before copying any code.
