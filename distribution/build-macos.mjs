import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, cp, chmod, mkdtemp, rm, rename, access, readdir, readlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const command = promisify(execFile);
const here = fileURLToPath(new URL('.', import.meta.url));
const appSource = path.resolve(here, '..');
const argument = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const sha256 = async file => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};

async function build() {
  const version = argument('--node-version'), output = argument('--out'), sumsFile = argument('--checksums');
  if (!/^v22\.\d+\.\d+$/.test(version || '') || !output || !sumsFile) {
    throw new Error('Usage: node distribution/build-macos.mjs --node-version v22.x.x --checksums SHASUMS256.txt --node-arm64 archive.tar.gz --node-x64 archive.tar.gz --out /absolute/path/Duet-Mac-Beta');
  }
  if (!path.isAbsolute(output)) throw new Error('--out must be an absolute path.');
  for (const destination of [output, `${output}.zip`]) {
    try { await access(destination); throw new Error(`Refusing to overwrite an existing distribution: ${destination}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const checksums = new Map((await readFile(sumsFile, 'utf8')).trim().split(/\r?\n/).map(line => {
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/); return match ? [match[2], match[1]] : [];
  }).filter(entry => entry.length));
  const bundleName = path.basename(output);
  const stage = await mkdtemp(path.join(os.tmpdir(), 'duet-distribution-'));
  const bundle = path.join(stage, bundleName);
  try {
    await mkdir(path.join(bundle, 'app'), { recursive: true });
    // This allowlist is intentional: data/, .env, tests, projects, and accounts
    // can never enter a shareable package through a recursive source copy.
    for (const directory of ['src', 'public']) {
      await cp(path.join(appSource, directory), path.join(bundle, 'app', directory), { recursive: true, dereference: true });
    }
    await cp(path.join(appSource, 'package.json'), path.join(bundle, 'app/package.json'));
    for (const name of ['README.md', 'RECOVERY.md']) await cp(path.join(appSource, name), path.join(bundle, name));
    await cp(path.join(here, 'Start Duet.command'), path.join(bundle, 'Start Duet.command'));
    await chmod(path.join(bundle, 'Start Duet.command'), 0o755);
    await cp(path.join(here, 'START HERE.txt'), path.join(bundle, 'START HERE.txt'));
    try { await cp(path.join(here, 'BETA-TEST.md'), path.join(bundle, 'BETA-TEST.md')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(path.join(bundle, 'LICENSES'), { recursive: true });
    const pkg = JSON.parse(await readFile(path.join(appSource, 'package.json'), 'utf8'));
    const manifest = { format: 1, appVersion: pkg.version, minimumMacOS: '13', nodeVersion: version, runtimes: {} };
    for (const arch of ['arm64', 'x64']) {
      const filename = `node-${version}-darwin-${arch}.tar.gz`;
      const archive = argument(`--node-${arch}`);
      if (!archive || path.basename(archive) !== filename) throw new Error(`Provide the official ${filename} archive.`);
      const expected = checksums.get(filename);
      if (!expected || await sha256(archive) !== expected) throw new Error(`Official SHA256 verification failed for ${filename}.`);
      const listed = (await command('/usr/bin/tar', ['-tzf', archive], { maxBuffer: 20 * 1024 * 1024 })).stdout.split('\n').filter(Boolean);
      const prefix = `node-${version}-darwin-${arch}`;
      if (listed.some(entry => entry.startsWith('/') || entry.split('/').includes('..') || !entry.startsWith(prefix + '/'))) throw new Error(`Unsafe archive paths in ${filename}.`);
      const extraction = path.join(stage, `extract-${arch}`);
      await mkdir(extraction);
      await command('/usr/bin/tar', ['-xzf', archive, '-C', extraction], { maxBuffer: 4 * 1024 * 1024 });
      const source = path.join(extraction, prefix), runtime = path.join(bundle, 'runtimes', `darwin-${arch}`);
      await mkdir(path.join(runtime, 'bin'), { recursive: true });
      for (const relative of ['bin/node', 'bin/npm', 'bin/npx', 'lib/node_modules/npm', 'LICENSE']) {
        await mkdir(path.dirname(path.join(runtime, relative)), { recursive: true });
        await cp(path.join(source, relative), path.join(runtime, relative), { recursive: true, dereference: false, verbatimSymlinks: true });
      }
      await chmod(path.join(runtime, 'bin/node'), 0o755);
      const nodeSha256 = await sha256(path.join(runtime, 'bin/node'));
      await writeFile(path.join(runtime, 'node.sha256'), nodeSha256 + '\n');
      const npm = JSON.parse(await readFile(path.join(runtime, 'lib/node_modules/npm/package.json'), 'utf8'));
      await cp(path.join(source, 'LICENSE'), path.join(bundle, 'LICENSES', `Node-${version}-${arch}.txt`));
      await cp(path.join(runtime, 'lib/node_modules/npm/LICENSE'), path.join(bundle, 'LICENSES', `npm-${npm.version}-${arch}.txt`));
      manifest.runtimes[`darwin-${arch}`] = { archive: filename, archiveSha256: expected, nodeSha256,
        npmVersion: npm.version, sourceURL: `https://nodejs.org/dist/${version}/${filename}` };
      console.log(`Verified and packaged ${filename}`);
    }
    await writeFile(path.join(bundle, 'distribution.json'), JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(path.join(bundle, 'LICENSES/README.txt'), 'Node.js and bundled dependencies are distributed under the terms in the accompanying Node licenses. npm and its vendored dependencies include their own license notices under runtimes/*/lib/node_modules/npm. Official runtime archive checksums and source URLs are recorded in distribution.json.\n');
    // Reject hidden files, links escaping runtimes, or private source paths.
    async function inspect(relative = '') {
      for (const entry of await readdir(path.join(bundle, relative), { withFileTypes: true })) {
        const item = path.join(relative, entry.name);
        if (entry.name.startsWith('.') && !item.startsWith('runtimes/')) throw new Error(`Hidden file is not allowed in the distribution: ${item}`);
        if (entry.isSymbolicLink()) {
          const target = await readlink(path.join(bundle, item));
          const resolved = path.resolve(bundle, path.dirname(item), target);
          const runtimeRoot = path.join(bundle, ...item.split(path.sep).slice(0, 2));
          if (!item.startsWith('runtimes/') || path.isAbsolute(target) || !resolved.startsWith(runtimeRoot + path.sep)) {
            throw new Error(`A distribution link points outside its runtime: ${item}`);
          }
        }
        if (entry.isDirectory()) await inspect(item);
        if (entry.isFile() && /\.(mjs|js|css|html|json|txt|md|command)$/i.test(entry.name) && !item.startsWith('runtimes/')) {
          const contents = await readFile(path.join(bundle, item), 'utf8');
          if (contents.includes(os.homedir())) throw new Error(`Creator home path found in distribution: ${item}`);
        }
      }
    }
    await inspect();
    await mkdir(path.dirname(output), { recursive: true });
    const temporaryZip = path.join(stage, `${bundleName}.zip`);
    await command('/usr/bin/ditto', ['-c', '-k', '--keepParent', bundle, temporaryZip], { maxBuffer: 1024 * 1024 });
    await rename(bundle, output);
    await rename(temporaryZip, `${output}.zip`);
    const archiveHash = await sha256(`${output}.zip`);
    await writeFile(`${output}.zip.sha256`, `${archiveHash}  ${bundleName}.zip\n`);
    console.log(`Distribution: ${output}.zip`);
    console.log(`SHA256: ${archiveHash}`);
  } finally { await rm(stage, { recursive: true, force: true }); }
}
try { await build(); } catch (error) { console.error(error.message); process.exitCode = 1; }
