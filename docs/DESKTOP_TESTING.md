# Test the Windows desktop application

The current development Electron executable is unsigned. On this machine, Windows Code Integrity events confirm that Smart App Control blocks it before application code starts. The desktop build has been refreshed with the UI changes on 18 September 2026. `npm run package:desktop` passed; this does not constitute a successful native launch.

Windows Sandbox provides an isolated Windows desktop test environment. It must first be installed as a Windows optional feature, which requires administrator approval and may require a restart. This workflow does not change the host's Smart App Control policy.

After Windows Sandbox is installed:

1. Double-click `Test Media Workbench.wsb` in the repository root.
2. Wait for Sandbox to copy the packaged app and open Media Workbench.
3. Import `C:\TestFiles\sample.mp4`, or put your own media into `test-output/desktop-sandbox-files` on the host and import it from `C:\TestFiles` inside Sandbox.
4. Save exports to `C:\TestFiles` to retain them on the host.

Closing Sandbox erases its application data, imported library, projects, and settings. Only files explicitly saved in the shared test folder persist. Native clipboard, drag-out and reveal actions operate within the guest desktop; behavior with applications on the host still requires a host desktop test.

The package is mapped read-only and copied inside the guest before launch. Only the dedicated test-files folder is writable from the guest. The source workspace and host credentials are not mapped.

To refresh the package and launcher after source changes:

```powershell
npm run package:desktop
node scripts/prepare-desktop-sandbox.mjs
```

Validation: package generation and provenance checks passed; generated WSB XML parsed successfully and both mapped directories exist. Sandbox launch remains untested until the optional Windows feature is installed.

Microsoft reference: https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file
