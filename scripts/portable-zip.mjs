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

export async function readPortableZipEntries(archive, input = process.env) {
  if (process.platform !== 'win32') throw Error('Windows portable ZIP inspection requires Windows');
  const target = path.resolve(archive), env = portableEnvironment(input, path.dirname(target));
  const powershell = path.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [System.IO.Compression.ZipFile]::OpenRead($env:MW_ZIP_ARCHIVE); try { $names = @($zip.Entries | ForEach-Object { $_.FullName }); ConvertTo-Json -InputObject $names -Compress } finally { $zip.Dispose() }";
  const result = await execute(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...env, MW_ZIP_ARCHIVE: target }, windowsHide: true, timeout: 60000, maxBuffer: 10 * 1024 ** 2
  });
  const names = JSON.parse(result.stdout.trim());
  if (!Array.isArray(names) || !names.length) throw Error('Portable ZIP contains no readable entries');
  return names;
}
export function validatePortableZipEntries(entries, prefix) {
  const names = entries.map(name => {
    if (typeof name !== 'string' || !name.trim() || name.includes('\0')) throw Error('Portable ZIP has an empty or unreadable entry name');
    const normalized = name.replaceAll('\\', '/');
    if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.split('/').some(part => part === '..' || part === '.') || !normalized.startsWith(prefix)) throw Error('Portable ZIP entry escapes its expected folder: ' + normalized);
    return normalized;
  });
  return names;
}
