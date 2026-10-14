import { packageDesktop } from './package-desktop.mjs';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { hashFile } from './portable-package-utils.mjs';
import { createPortableZip, readPortableZipEntries, validatePortableZipEntries } from './portable-zip.mjs';

const outputs = await packageDesktop({ portable: true });
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const results = [];
for (const folder of outputs) {
  const output = path.resolve(folder), parent = path.dirname(output);
  const archive = path.join(parent, 'Media-Workbench-v' + pkg.version + '-windows-x64-portable.zip');
  const releaseRoot = path.resolve('release');
  if (parent !== releaseRoot || path.dirname(archive) !== releaseRoot || path.basename(archive) !== 'Media-Workbench-v' + pkg.version + '-windows-x64-portable.zip') throw Error('Unsafe portable archive output path');
  await rm(archive, { force: true });
  await createPortableZip(output, archive);
  const prefix = path.basename(output) + '/';
  const listing = validatePortableZipEntries(await readPortableZipEntries(archive), prefix);
  if (listing.some(name => ['.git/', '.data/', '.runtime/', 'test-output/', 'data/', 'resources/app/.data/', 'resources/app/.runtime/', 'resources/app/data/'].some(excluded => name.startsWith(prefix + excluded)) || /\/\.tools\/(?:ffmpeg|ffprobe|yt-dlp)\.exe(?:\.previous)?$/i.test(name))) throw Error('Portable ZIP contains excluded runtime data or native binaries');
  const expected = path.basename(output) + '/';
  for (const file of ['Start Media Workbench.cmd', 'resources/app/.tools/node.exe', 'resources/app/scripts/portable-bootstrap.mjs', 'LICENSE', 'LICENSES.chromium.html']) if (!listing.includes(expected + file)) throw Error('Portable ZIP is missing ' + file);
  const provenance = JSON.parse(await readFile(path.join(output, 'package-provenance.json'), 'utf8'));
  const checksum = await hashFile(archive);
  await writeFile(archive + '.sha256', checksum + '  ' + path.basename(archive) + '\n');
  const record = { schemaVersion: 1, sourceCommit: provenance.sourceCommit, version: pkg.version, folder: path.basename(output), archive: path.basename(archive), sha256: checksum, bootstrapRequired: true, firstLaunchNetworkRequired: true, nativeBinariesIncluded: false, archiveInventoryChecked: true };
  await writeFile(path.join(parent, 'portable-release.json'), JSON.stringify(record, null, 2));
  results.push(record);
}
console.log(JSON.stringify({ portableArchives: results }, null, 2));
