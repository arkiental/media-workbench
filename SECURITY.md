# Security reporting

This development build defaults to authenticated loopback use. Opt-in shared mode requires the isolated worker and mandatory egress profile described in docs/SHARED_HOSTING.md. Synthetic integration and independent boundary tests have passed; no public deployment or production Linux controller has been verified. Run the security tests on the actual deployment host. Never bypass startup gates with a tunnel or edited bind address.

For a vulnerability, prepare a minimal synthetic fixture, affected revision, reproduction steps and impact. Do not include credentials, session-cookie jars, personal media or secret URLs. A public repository/security contact has not been established; deliver sensitive reports privately to the repository owner, not in public issue comments. No telemetry or automatic crash upload is present.

Keep Node/Electron/FFmpeg/yt-dlp current after compatibility testing. Validate official sources and checksums. The app's filtering proxy is defense in depth for local downloads; it is not a native-tool sandbox. Treat imported untrusted media as potentially hostile to native decoders.
