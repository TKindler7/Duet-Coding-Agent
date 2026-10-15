import os from 'node:os';
import path from 'node:path';
import { mkdtemp, realpath, rm, access } from 'node:fs/promises';
import { execute } from './process.mjs';

export function workspaceProfile(project, scratch, userHome = os.homedir(), runtimeRoot) {
  const protectedPaths = ['.ssh', '.aws', '.azure', '.config', '.claude', '.codex', '.npmrc', '.netrc', '.git-credentials', 'Library/Keychains', 'Library/Application Support', 'Library/LaunchAgents'];
  const quote = value => JSON.stringify(value);
  const ancestors = new Set();
  for (const root of [project, runtimeRoot].filter(Boolean)) {
    for (let parent = path.dirname(root); parent !== path.dirname(parent); parent = path.dirname(parent)) ancestors.add(parent);
  }
  return ['(version 1)', '(deny default)', '(allow process-exec)', '(allow process-fork)',
    '(allow sysctl-read)', '(allow file-read*)',
    ...protectedPaths.map(value => `(deny file-read* (subpath ${quote(path.join(userHome, value))}))`),
    `(allow file-read* (subpath ${quote(project)}))`,
    ...(runtimeRoot ? [`(allow file-read* (subpath ${quote(runtimeRoot)}))`] : []),
    // Node resolves every ancestor with lstat; metadata does not grant access to
    // sibling accounts, directory listings, or their file contents.
    `(allow file-read-metadata ${[...ancestors].map(value => `(literal ${quote(value)})`).join(' ')})`,
    `(allow file-write* (subpath ${quote(project)}) (subpath ${quote(scratch)}) (literal "/dev/null"))`,
    `(deny file-write* (subpath ${quote(path.join(project, '.duet'))}))`,
    '(deny network*)',
  ].join('\n');
}

// Project scripts are code. Keep them within the same workspace-write boundary
// as implementation, and do not silently fall back to an unrestricted process.
export async function executeWorkspaceCheck(command, args, options = {}) {
  if (process.platform !== 'darwin') throw Object.assign(new Error('Automatic project checks currently require the macOS workspace sandbox. Verify these requirements manually on this platform.'), { code: 'DUET_CHECK_UNAVAILABLE' });
  try { await access('/usr/bin/sandbox-exec'); }
  catch { throw Object.assign(new Error('The macOS workspace sandbox is unavailable. No project script was started.'), { code: 'DUET_CHECK_UNAVAILABLE' }); }
  if (command !== 'npm' || args.length !== 3 || args[0] !== '--ignore-scripts' || args[1] !== 'run' || !['test', 'build'].includes(args[2])) {
    throw new Error('Only declared project test and build scripts may run in the verification sandbox.');
  }
  const project = await realpath(options.cwd);
  const nodePath = await realpath(process.execPath);
  const runtimeRoot = path.dirname(path.dirname(nodePath));
  let npmCli;
  try {
    if (path.basename(path.dirname(nodePath)) !== 'bin') throw new Error('Unexpected runtime layout.');
    npmCli = await realpath(path.join(runtimeRoot, 'lib/node_modules/npm/bin/npm-cli.js'));
    if (!npmCli.startsWith(runtimeRoot + path.sep)) throw new Error('npm is outside the runtime.');
  } catch {
    throw Object.assign(new Error('The current Node runtime does not include npm in its expected location. Automatic checks were not started.'), { code: 'DUET_CHECK_UNAVAILABLE' });
  }
  const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'duet-check-')));
  try {
    const profile = workspaceProfile(project, scratch, os.homedir(), runtimeRoot);
    const result = await execute('/usr/bin/sandbox-exec', ['-p', profile, nodePath, npmCli, ...args], {
      ...options, cwd: project,
      env: { ...options.env, HOME: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch, npm_config_cache: path.join(scratch, 'npm-cache') },
    });
    if (/sandbox-exec: (?:sandbox_apply|Operation not permitted)|sandbox initialization failed/i.test(result.stderr)) {
      throw Object.assign(new Error('The workspace sandbox could not start. No unrestricted retry was attempted.'), { code: 'DUET_CHECK_UNAVAILABLE', result });
    }
    return result;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
