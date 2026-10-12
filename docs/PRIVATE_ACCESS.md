# Private access from your devices

Media Workbench can serve its browser interface through an existing Tailscale Serve HTTPS route. The PC must be awake, Tailscale must be connected on both devices, and the backend and Serve session must be running. Existing tailnet access rules apply. This does not configure a public website or enable Funnel.

Token authentication is the default. Pair by entering the existing owner credential locally; its file is `owner-token` in the configured `MW_DATA_DIR`. Do not share the credential or put it in a URL. Private HTTPS pairing uses Secure, HttpOnly, SameSite=Strict cookies.

## Example token-protected session

Replace the example hostname and workspace folder with your own values. Preserve your existing workspace rather than opening an empty directory.

```powershell
$env:MW_HOST='127.0.0.1'
$env:MW_PORT='4319'
$env:MW_DATA_DIR="$env:LOCALAPPDATA\MediaWorkbench\data"
$env:MW_PRIVATE_ORIGIN='https://workstation.example.ts.net:9443'
$env:MW_PRIVATE_NO_TOKEN='0'
$env:MW_SHARED='0'
$env:MW_ISOLATE='0'
$env:MW_TUNNEL_PROTOTYPE='0'
$env:MW_PUBLIC_ORIGIN=''
$env:MW_OWNER_TOKEN=''
$env:MW_DESKTOP_SECRET=''
npm start
```

An empty `MW_OWNER_TOKEN` preserves the credential already registered in the workspace. In a separate terminal, use your installed Tailscale CLI:

```powershell
tailscale serve --https=9443 http://127.0.0.1:4319
```

Open your private HTTPS address on the connected device. The foreground Serve session stops when its terminal exits. These commands do not install a Windows service or login/reboot task. Preserve other Serve routes; do not reset the global configuration. See [Tailscale Serve documentation](https://tailscale.com/docs/reference/tailscale-cli/serve).

## Optional token-free private access

`MW_PRIVATE_NO_TOKEN=1` is an explicit opt-in. Every identified visitor permitted by your existing tailnet rules to reach this Serve route receives the same owner workspace access, including media, jobs and settings. This includes permitted shared-node visitors. Use this setting only when that access is intended.

The setting requires a bare HTTPS `.ts.net` origin, a loopback backend, the exact private Host and port, a raw loopback peer and the identity header supplied by Serve. Shared, public and tunnel combinations reject it before storage opens. Requests without a Serve identity, including direct loopback requests, still require a token. Tagged devices without a Serve identity cannot use the bypass. No login cookie or credential is issued by this path. Host and Origin checks remain enabled. See [Tailscale identity headers](https://tailscale.com/docs/features/tailscale-serve#identity-headers).

To restore token authentication, set `MW_PRIVATE_NO_TOKEN=0` or unset it and restart the same backend. No credential reset or route change is needed. The flag is process-scoped.

## Verification

Controlled tests verify default token protection, exact private Host/Origin handling, rejected configuration combinations, missing identity and direct-loopback denial, and opt-in owner access through Serve identity. A mobile-sized browser verified the private Library with no overflow or script errors. Access from a physical phone remains a device-side check. [Public hosting templates](PUBLIC_WEB_MODE.md) describe a separate deployment and are not activated by these examples.
