# Password-protected Cloudflare tunnel

Share the browser version of Media Workbench through a temporary Cloudflare quick tunnel. Everyone who opens the link must enter the password before they can see or do anything.

```sh
npm run tunnel
```

This builds the app, starts the service on `127.0.0.1:4329`, opens a random `https://….trycloudflare.com` link with `cloudflared`, and prints the link and password. Press Ctrl+C to stop both. The link changes every time the tunnel starts.

| Setting | Default |
| --- | --- |
| `MW_TUNNEL_PASSWORD` | Generated once (for example `abcd-efgh-jkmn-pqrs`) and kept in `<data dir>/tunnel-password`. Run `node scripts/tunnel.mjs --new-password` to replace it. Custom passwords need at least 10 characters. |
| `MW_DATA_DIR` | `.data-tunnel`, a workspace separate from the desktop app's library. |
| `MW_PORT` | `4329` |
| `MW_CLOUDFLARED` | `cloudflared` on `PATH` |

## How visitors are protected

- The password is the only way in. Visitors sign in as a limited **Tunnel visitor** member, never as the owner, so they cannot manage users, use saved browser accounts, choose folders on the PC or run desktop actions.
- Starting with a different password revokes the previous one immediately.
- The session cookie is `Secure`, `HttpOnly` and `SameSite=Strict`. Only `*.trycloudflare.com` hostnames and same-origin requests are accepted.
- Sign-in attempts through the tunnel share one limit of 20 per minute, which slows password guessing.
- Downloads still go through the address filter that blocks loopback, private and metadata addresses, so visitors cannot reach your home network through the server.

Quick tunnels are meant for testing: Cloudflare gives no uptime guarantee and the address is random. For a permanent address, use a named Cloudflare tunnel with your own domain; that hostname is not accepted yet and would need to be added to the server's allowed hosts first.
