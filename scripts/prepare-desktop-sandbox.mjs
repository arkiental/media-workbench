import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const packaged = path.join(root, 'release', 'Media Workbench-win32-x64');
await access(path.join(packaged, 'media-workbench.exe'));
const files = path.join(root, 'test-output', 'desktop-sandbox-files');
await mkdir(files, { recursive: true });
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const command = `powershell.exe -NoProfile -Command "Copy-Item -LiteralPath 'C:\\WorkbenchPackage' -Destination 'C:\\MediaWorkbench' -Recurse; Start-Process -FilePath 'C:\\MediaWorkbench\\media-workbench.exe' -WorkingDirectory 'C:\\MediaWorkbench'"`;
const config = `<Configuration>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>${xml(packaged)}</HostFolder>
      <SandboxFolder>C:\\WorkbenchPackage</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>${xml(files)}</HostFolder>
      <SandboxFolder>C:\\TestFiles</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand><Command>${xml(command)}</Command></LogonCommand>
</Configuration>
`;
const launcher = path.join(root, 'Test Media Workbench.wsb');
await writeFile(launcher, config);
await writeFile(path.join(files, 'README.txt'), 'Put media for desktop testing in this folder. Inside Windows Sandbox it is C:\\TestFiles.\r\nSave exported files to C:\\TestFiles to keep them after closing Sandbox.\r\nSandbox app settings, projects and imported media are erased when Sandbox closes.\r\n');
console.log(`Desktop sandbox launcher: ${launcher}\nPersistent test files: ${files}\nRequires the Windows Sandbox optional feature. No host security policies are changed.`);
