import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { portableEnvironment } from './portable-package-utils.mjs';

const execute = promisify(execFile);
export async function createPortableZip(directory, archive, input = process.env) {
  if (process.platform !== 'win32') throw Error('Windows portable ZIP creation requires Windows');
  const source = path.resolve(directory), target = path.resolve(archive);
  const env = portableEnvironment(input, source);
  const powershell = path.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:MW_ZIP_SOURCE, $env:MW_ZIP_OUTPUT, [System.IO.Compression.CompressionLevel]::Optimal, $true)';
  await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    cwd: path.dirname(source), env: { ...env, MW_ZIP_SOURCE: source, MW_ZIP_OUTPUT: target },
    windowsHide: true, timeout: 600000, maxBuffer: 1024 ** 2
  });
}
