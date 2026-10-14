import { createHash } from 'node:crypto';
import { readFile, readdir, stat, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const schemaVersion = 1;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const statePath = root => path.join(root, 'dist', '.build-state.json');

async function filesUnder(root, directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => {
    const relative = `${directory}/${entry.name}`;
    return entry.isDirectory() ? filesUnder(root, relative) : entry.isFile() ? [relative] : [];
  }));
  return files.flat().sort();
}

async function fileHashes(root, files) {
  return Promise.all(files.map(async file => [file, hash(await readFile(path.join(root, file)))]));
}

export async function dependencyState(root) {
  const [pkg, lock] = await Promise.all(['package.json', 'package-lock.json'].map(async file => JSON.parse(await readFile(path.join(root, file), 'utf8'))));
  const installed = [];
  for (const group of ['dependencies', 'devDependencies']) {
    for (const [name, requested] of Object.entries(pkg[group] || {}).sort(([a], [b]) => a.localeCompare(b))) {
      const locked = lock.packages?.[`node_modules/${name}`]?.version;
      if (!locked || lock.packages?.['']?.[group]?.[name] !== requested) {
        throw new Error(`package-lock.json does not match ${name}. Synchronize the lockfile before running npm ci.`);
      }
      let actual;
      try { actual = JSON.parse(await readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version; }
      catch { throw new Error(`Dependency ${name} is missing or unreadable. Run npm ci to repair dependencies.`); }
      if (actual !== locked) throw new Error(`Dependency ${name} is ${actual}; package-lock.json requires ${locked}. Run npm ci to repair dependencies.`);
      installed.push([name, actual]);
    }
  }
  const installedLock = await readFile(path.join(root, 'node_modules', '.package-lock.json')).catch(error => {
    if (error.code === 'ENOENT') return Buffer.from('');
    throw error;
  });
  return { installed, installedLock: hash(installedLock) };
}

export async function buildInputs(root) {
  const groups = await Promise.all(['apps', 'packages', 'tests'].map(directory => filesUnder(root, directory)));
  const files = groups.flat().filter(file => file.startsWith('packages/') || /\.tsx?$/.test(file) || file.startsWith('apps/web/src/') || file.startsWith('apps/web/assets/') || file === 'apps/web/index.html');
  files.push('package.json', 'package-lock.json', 'tsconfig.json', 'scripts/build.mjs', 'scripts/build-state.mjs');
  const [sources, dependencies] = await Promise.all([fileHashes(root, files.sort()), dependencyState(root)]);
  return hash(JSON.stringify({ schemaVersion, sources, dependencies, node: process.versions.node, platform: process.platform, arch: process.arch }));
}

async function buildOutputs(root) {
  const files = (await Promise.all(['dist/server', 'dist/web'].map(directory => filesUnder(root, directory)))).flat().sort();
  for (const required of ['dist/server/main.js', 'dist/web/main.js', 'dist/web/index.html']) {
    if (!files.includes(required) || !(await stat(path.join(root, required))).size) throw new Error(`Build output ${required} is missing or empty.`);
  }
  return fileHashes(root, files);
}

export async function buildFreshness(root, inputHash = undefined) {
  let saved;
  try { saved = JSON.parse(await readFile(statePath(root), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return { current: false, reason: 'No completed build record' };
    throw error;
  }
  if (saved?.schemaVersion !== schemaVersion || saved.inputHash !== (inputHash || await buildInputs(root))) return { current: false, reason: 'Source, configuration or dependencies changed' };
  let outputs;
  try { outputs = await buildOutputs(root); }
  catch (error) {
    if (error.code === 'ENOENT' || error.message.startsWith('Build output ')) return { current: false, reason: 'Build outputs are missing' };
    throw error;
  }
  if (JSON.stringify(saved.outputs) !== JSON.stringify(outputs)) return { current: false, reason: 'Build outputs changed' };
  return { current: true, reason: 'Build matches source and dependencies', builtAt: saved.builtAt };
}

export async function recordBuild(root, inputHash) {
  if (await buildInputs(root) !== inputHash) throw new Error('Source or dependencies changed during the build. Run the build again.');
  const outputs = await buildOutputs(root);
  await mkdir(path.join(root, 'dist'), { recursive: true });
  const target = statePath(root);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ schemaVersion, inputHash, outputs, builtAt: new Date().toISOString() }, null, 2));
  await rename(temporary, target);
}
