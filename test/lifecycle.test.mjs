import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { DEFAULT_PORT, readServerConfig, parsePort, startServer, waitForServer, probeServer } from '../src/lifecycle.mjs';
import { installService, launchAgentPlist, installationPaths, SERVICE_LABEL } from '../src/install-service.mjs';

const silent = { log() {}, error() {} };
const token = 'b'.repeat(64);
const offline = async () => ({ running: false, duet: false });
async function data() { return mkdtemp(path.join(os.tmpdir(), 'duet-lifecycle-')); }
function serverFactory(calls, failure) {
  return async options => {
    calls.push({ create: options });
    const server = new EventEmitter();
    server.listen = (port, host, callback) => {
      calls.push({ bind: { port, host } });
      queueMicrotask(() => failure ? server.emit('error', failure) : callback());
    };
    return { server, close: async () => calls.push({ close: true }) };
  };
}

test('restores the saved loopback address and token, even after restarts', async () => {
  const dataDir = await data();
  const calls = [];
  await writeFile(path.join(dataDir, 'server.json'), JSON.stringify({ origin: 'http://127.0.0.1:63121', token }));
  const options = { dataDir, root: dataDir, probe: offline, createWebApp: serverFactory(calls), handleSignals: false, logger: silent };
  const first = await startServer(options);
  assert.equal(first.origin, 'http://127.0.0.1:63121');
  assert.equal(first.token, token);
  await first.close();
  await first.close();
  const second = await startServer(options);
  assert.equal(second.token, first.token);
  assert.deepEqual(calls.filter(x => x.bind), [{ bind: { port: 63121, host: '127.0.0.1' } }, { bind: { port: 63121, host: '127.0.0.1' } }]);
  assert.equal(calls.filter(x => x.close).length, 1);
  assert.equal((await stat(path.join(dataDir, 'server.json'))).mode & 0o777, 0o600);
  await second.close();
});

test('new installs choose a stable port; invalid saved tokens and remote origins are not used', async () => {
  const dataDir = await data();
  await writeFile(path.join(dataDir, 'server.json'), JSON.stringify({ origin: 'https://example.com:8888', token: 'oops' }));
  const config = await readServerConfig(dataDir);
  assert.equal(config.port, DEFAULT_PORT);
  assert.match(config.token, /^[a-f0-9]{64}$/);
  assert.equal((await readServerConfig(dataDir, { port: '63333' })).port, 63333);
  for (const port of ['0', '80', '65536', '1.5', 'foo', '12345/path']) assert.throws(() => parsePort(port));
});

test('a startup lock left by a crashed process is recovered without losing the saved address', async () => {
  const dataDir = await data();
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  await writeFile(path.join(dataDir, 'server-start.lock'), JSON.stringify({ pid: child.pid, nonce: 'previous-startup' }));
  await writeFile(path.join(dataDir, 'server.json'), JSON.stringify({ origin: 'http://127.0.0.1:63121', token }));
  const app = await startServer({ dataDir, root: dataDir, probe: offline, createWebApp: serverFactory([]), handleSignals: false, logger: silent });
  assert.equal(app.token, token);
  await assert.rejects(readFile(path.join(dataDir, 'server-start.lock')), { code: 'ENOENT' });
  await app.close();
});

test('duplicate launches reuse the existing service without opening a second server', async () => {
  const dataDir = await data();
  await writeFile(path.join(dataDir, 'server.json'), JSON.stringify({ origin: 'http://127.0.0.1:63121', token }));
  const calls = [];
  const result = await startServer({ root: dataDir, dataDir, createWebApp: serverFactory(calls),
    probe: async () => ({ running: true, duet: true }), open: true,
    native: async (...args) => { calls.push({ native: args }); return { code: 0 }; }, logger: silent });
  assert.equal(result.reused, true);
  assert.deepEqual(calls, [{ native: ['/usr/bin/open', [`http://127.0.0.1:63121/#${token}`]] }]);
});

test('an occupied address fails clearly without switching ports or stopping any process', async () => {
  const dataDir = await data();
  const calls = [];
  await assert.rejects(startServer({ root: dataDir, dataDir, createWebApp: serverFactory(calls),
    probe: async () => ({ running: true, duet: false }), logger: silent }), /Another application/);
  assert.deepEqual(calls, []);
  await assert.rejects(startServer({ root: dataDir, dataDir, createWebApp: serverFactory(calls, { code: 'EADDRINUSE' }),
    probe: offline, logger: silent }), /Duet will keep this address/);
  assert.deepEqual(calls.at(-1), { close: true });
});

test('readiness distinguishes a local Duet server from an unrelated website', async () => {
  assert.deepEqual(await probeServer('http://127.0.0.1:63121', {
    fetchImpl: async () => ({ ok: true, json: async () => ({ app: 'duet', version: '0.3.0' }) }),
  }), { running: true, duet: true, version: '0.3.0' });
  assert.equal((await probeServer('http://127.0.0.1:63121', { fetchImpl: async () => ({ json: async () => { throw new Error('HTML'); } }) })).duet, false);
  let probes = 0;
  const state = await waitForServer('http://127.0.0.1:63121', { pause: async () => {}, probe: async () => (++probes === 2 ? { duet: true } : { running: false }) });
  assert.equal(state.duet, true);
  assert.equal(probes, 2);
  await assert.rejects(waitForServer('http://127.0.0.1:63121', { timeoutMs: 0 }), /did not start/);
});

async function installation() {
  const home = await data();
  const appRoot = path.join(home, 'My Projects & Apps', 'duet');
  await mkdir(path.join(appRoot, 'src'), { recursive: true });
  await mkdir(path.join(appRoot, 'data'));
  await mkdir(path.join(appRoot, 'public'));
  await writeFile(path.join(appRoot, 'src/web.mjs'), '');
  await writeFile(path.join(appRoot, 'public/index.html'), '<h1>Duet</h1>');
  await writeFile(path.join(appRoot, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(appRoot, 'data/server.json'), JSON.stringify({ origin: 'http://127.0.0.1:63121', token }));
  return { home, appRoot, nodePath: '/opt/homebrew/bin/node', uid: 501, platform: 'darwin' };
}

test('launchd config starts on login, restarts after failure, and safely escapes filesystem paths', () => {
  const plist = launchAgentPlist({ appRoot: '/test/a & b/<duet>', nodePath: '/node', home: '/Users/Name', port: 63121 });
  assert.match(plist, /a &amp; b\/&lt;duet&gt;/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<string>63121<\/string>/);
  assert.doesNotMatch(plist, /--open/);
});

test('installer registers only the current user service and opens the browser after readiness', async () => {
  const options = await installation();
  const calls = [];
  const result = await installService({ ...options, open: true,
    command: async (cmd, args) => { calls.push([cmd, args]); if (args[0] === 'print') throw new Error('not loaded'); return {}; },
    wait: async origin => { calls.push(['ready', origin]); },
  });
  assert.equal(result.origin, 'http://127.0.0.1:63121');
  assert.deepEqual(calls.map(x => x[0]), ['/bin/launchctl', '/bin/launchctl', 'ready', '/usr/bin/open']);
  assert.deepEqual(calls[1][1], ['bootstrap', 'gui/501', path.join(options.home, 'Library/LaunchAgents', `${SERVICE_LABEL}.plist`)]);
  assert.equal(calls.at(-1)[1][0], `http://127.0.0.1:63121/#${token}`);
  assert.equal((await stat(result.agentFile)).mode & 0o777, 0o600);
  const plist = await readFile(result.agentFile, 'utf8');
  assert.match(plist, /Application Support\/Duet\/app\/src\/web.mjs/);
  assert.doesNotMatch(plist, /My Projects/);
  assert.match(plist, /DUET_DATA_DIR/);
  assert.equal(JSON.parse(await readFile(path.join(result.paths.data, 'server.json'), 'utf8')).token, token);
});

test('reopening the app reuses launchd without restarting or interrupting an active build', async () => {
  const options = await installation();
  await installService({ ...options, command: async (cmd, args) => { if (args[0] === 'print') throw new Error('not loaded'); return {}; }, wait: async () => {} });
  const calls = [];
  await installService({ ...options, command: async (...args) => { calls.push(args); return {}; }, wait: async () => {} });
  assert.deepEqual(calls.map(x => x[1][0]), ['print', 'kickstart']);
  assert.ok(calls.every(x => !x[1].includes('-k')));
  await assert.rejects(installService({ ...options, port: 64444, command: async () => ({}), wait: async () => {} }), /different location or port/);
});

test('runtime updates defer during active turns, update only while idle, and preserve newer installed chats', async () => {
  const options = await installation();
  const paths = installationPaths(options.home);
  const inactiveCommand = async (cmd, args) => { if (args[0] === 'print') throw new Error('not loaded'); return {}; };
  await installService({ ...options, command: inactiveCommand, wait: async () => {} });
  await writeFile(path.join(paths.data, 'conversations.json'), '{"installed":"newer"}');
  await writeFile(path.join(options.appRoot, 'data/conversations.json'), '{"source":"older"}');
  await writeFile(path.join(options.appRoot, 'public/index.html'), '<h1>Updated</h1>');
  const calls = [];
  let unloaded = false;
  const command = async (cmd, args) => {
    calls.push(args[0]);
    if (args[0] === 'bootout') unloaded = true;
    if (args[0] === 'print' && unloaded) throw Object.assign(new Error('not loaded'), { code: 113 });
    return {};
  };
  const pending = await installService({ ...options, command, wait: async () => {}, fetchImpl: async () => ({ ok: true, json: async () => ({ active: 'running-turn' }) }) });
  assert.equal(pending.updatePending, true);
  assert.deepEqual(calls, ['print', 'kickstart']);
  assert.equal(await readFile(path.join(paths.app, 'public/index.html'), 'utf8'), '<h1>Duet</h1>');
  calls.length = 0;
  const updated = await installService({ ...options, command, wait: async () => {}, fetchImpl: async () => ({ ok: true, json: async () => ({ active: null }) }) });
  assert.equal(updated.updatePending, false);
  assert.deepEqual(calls, ['print', 'bootout', 'print', 'bootstrap']);
  assert.equal(await readFile(path.join(paths.app, 'public/index.html'), 'utf8'), '<h1>Updated</h1>');
  assert.equal(await readFile(path.join(paths.data, 'conversations.json'), 'utf8'), '{"installed":"newer"}');
  assert.equal(await readFile(path.join(options.appRoot, 'data/conversations.json'), 'utf8'), '{"source":"older"}');
});

test('PATH-only service updates wait for setup to finish and retain all other service settings', async () => {
  const options=await installation();
  const result=await installService({...options,command:async(cmd,args)=>{if(args[0]==='print')throw new Error('not loaded');return {};},wait:async()=>{}});
  const correct=await readFile(result.agentFile,'utf8');
  const older=correct.replace(/<key>PATH<\/key><string>[^<]*<\/string>/,'<key>PATH</key><string>/usr/bin:/bin</string>');
  await writeFile(result.agentFile,older);
  const calls=[];let unloaded=false;const command=async(cmd,args)=>{calls.push(args[0]);if(args[0]==='bootout')unloaded=true;if(args[0]==='print'&&unloaded)throw Object.assign(new Error('not loaded'),{code:113});return {};};
  const pending=await installService({...options,command,wait:async()=>{},fetchImpl:async()=>({ok:true,json:async()=>({active:null,setup:{codex:{status:'installing'}}})})});
  assert.equal(pending.updatePending,true);assert.deepEqual(calls,['print','kickstart']);assert.equal(await readFile(result.agentFile,'utf8'),older);
  calls.length=0;
  await installService({...options,command,wait:async()=>{},fetchImpl:async()=>({ok:true,json:async()=>({active:null})})});
  assert.deepEqual(calls,['print','bootout','print','bootstrap']);assert.equal(await readFile(result.agentFile,'utf8'),correct);
});

async function runtimeUpgrade(t) {
  const options = await installation();
  t.after(() => rm(options.home, { recursive: true, force: true }));
  const oldNode = path.join(options.home, '.local/node/bin/node');
  const initial = await installService({ ...options, nodePath: oldNode,
    command: async (cmd, args) => { if (args[0] === 'print') throw new Error('not loaded'); return {}; },
    wait: async () => {},
  });
  const nodePath = path.join(initial.paths.support, 'runtime/node-v22.23.3-darwin-arm64/bin/node');
  const savedToken = 'c'.repeat(64);
  const connection = JSON.stringify({ origin: initial.origin, token: savedToken });
  const chats = JSON.stringify({ version: 1, chats: [{ id: 'saved-chat', title: 'Keep my project', messages: [] }], jobs: [] });
  await writeFile(path.join(initial.paths.data, 'server.json'), connection);
  await writeFile(path.join(initial.paths.data, 'conversations.json'), chats);
  await writeFile(path.join(initial.paths.projects, 'keep.txt'), 'Existing project files must survive');
  await writeFile(path.join(options.appRoot, 'data/conversations.json'), '{"source":"older download"}');
  const oldPlist = await readFile(initial.agentFile, 'utf8');
  const digest = await readFile(path.join(initial.paths.app, '.bundle-sha256'), 'utf8');
  const plistOptions = { appRoot: initial.paths.app, home: options.home, nodePath,
    port: 63121, dataDir: initial.paths.data, logsDir: initial.paths.logs,
    workingDirectory: initial.paths.support, projectRoot: initial.paths.projects };
  return { options: { ...options, nodePath }, initial, oldPlist, digest, connection, chats, savedToken, plistOptions };
}

async function assertPreservedRuntimeData(fixture) {
  assert.equal(await readFile(path.join(fixture.initial.paths.data, 'server.json'), 'utf8'), fixture.connection);
  assert.equal(await readFile(path.join(fixture.initial.paths.data, 'conversations.json'), 'utf8'), fixture.chats);
  assert.equal(await readFile(path.join(fixture.initial.paths.projects, 'keep.txt'), 'utf8'), 'Existing project files must survive');
  assert.equal(await readFile(path.join(fixture.initial.paths.app, '.bundle-sha256'), 'utf8'), fixture.digest);
}

test('idle runtime-path upgrades migrate an unchanged bundle and preserve installed token, chats, and projects', async t => {
  const fixture = await runtimeUpgrade(t);
  const calls = [], checks = [];
  let unloaded = false;
  const upgraded = await installService({ ...fixture.options,
    command: async (cmd, args) => {
      calls.push([cmd, args]);
      if (args[0] === 'bootout') unloaded = true;
      if (args[0] === 'print' && unloaded) throw Object.assign(new Error('not loaded'), { code: 113 });
      return {};
    },
    wait: async origin => { checks.push({ ready: origin }); },
    fetchImpl: async (url, options) => {
      checks.push({ url, authorization: options.headers.Authorization });
      return { ok: true, json: async () => ({ active: null, setup: {} }) };
    },
  });
  assert.equal(upgraded.updatePending, false);
  assert.deepEqual(calls.map(([cmd, args]) => [cmd, args[0]]), [
    ['/bin/launchctl', 'print'], ['/bin/launchctl', 'bootout'], ['/bin/launchctl', 'print'], ['/bin/launchctl', 'bootstrap'],
  ]);
  assert.deepEqual(checks, [
    { url: `${fixture.initial.origin}/api/state`, authorization: `Bearer ${fixture.savedToken}` },
    { ready: fixture.initial.origin },
  ]);
  assert.equal(await readFile(upgraded.agentFile, 'utf8'), launchAgentPlist(fixture.plistOptions));
  assert.equal(upgraded.url, `${fixture.initial.origin}/#${fixture.savedToken}`);
  assert.equal((await stat(upgraded.agentFile)).mode & 0o777, 0o600);
  await assertPreservedRuntimeData(fixture);
});

test('runtime-path upgrades defer active builds and tool setup without editing their launchd configuration', async t => {
  for (const [label, state] of [
    ['active build', { active: 'existing-build', setup: {} }],
    ['active tool setup', { active: null, setup: { codex: { status: 'installing' } } }],
  ]) {
    await t.test(label, async t => {
      const fixture = await runtimeUpgrade(t), calls = [];
      const deferred = await installService({ ...fixture.options,
        command: async (cmd, args) => { calls.push(args); return {}; }, wait: async () => {},
        fetchImpl: async () => ({ ok: true, json: async () => state }),
      });
      assert.equal(deferred.updatePending, true);
      assert.deepEqual(calls.map(args => args[0]), ['print', 'kickstart']);
      assert.ok(calls.every(args => !args.includes('-k')), 'reusing launchd must not kill its active work');
      assert.equal(await readFile(fixture.initial.agentFile, 'utf8'), fixture.oldPlist);
      await assertPreservedRuntimeData(fixture);
    });
  }
});

test('runtime migration fails closed when authentication or the active-work check cannot be verified', async t => {
  for (const [label, fetchImpl] of [
    ['authentication rejected', async () => ({ ok: false, status: 401 })],
    ['server unreachable', async () => { throw new Error('Connection refused'); }],
    ['invalid response body', async () => ({ ok: true, json: async () => { throw new Error('Invalid JSON'); } })],
  ]) {
    await t.test(label, async t => {
      const fixture = await runtimeUpgrade(t), calls = [];
      await assert.rejects(installService({ ...fixture.options,
        command: async (cmd, args) => { calls.push(args[0]); return {}; }, wait: async () => {}, fetchImpl,
      }));
      assert.deepEqual(calls, ['print']);
      assert.equal(await readFile(fixture.initial.agentFile, 'utf8'), fixture.oldPlist);
      await assertPreservedRuntimeData(fixture);
    });
  }
  for (const state of [{}, { active: undefined }, { active: false }, { active: 0 }]) {
    await t.test(`unknown active status ${JSON.stringify(state)}`, async t => {
      const fixture = await runtimeUpgrade(t), calls = [];
      let outcome;
      try {
        outcome = await installService({ ...fixture.options,
          command: async (cmd, args) => { calls.push(args[0]); return {}; }, wait: async () => {},
          fetchImpl: async () => ({ ok: true, json: async () => state }),
        });
      } catch (error) { assert.ok(error instanceof Error); }
      if (outcome) assert.equal(outcome.updatePending, true);
      assert.ok(calls.every(action => ['print', 'kickstart'].includes(action)));
      assert.equal(await readFile(fixture.initial.agentFile, 'utf8'), fixture.oldPlist);
      await assertPreservedRuntimeData(fixture);
    });
  }
});

test('runtime upgrades do not authorize unrelated service, project, data, logging, or argument changes', async t => {
  const variants = [
    ['server location', options => ({ ...options, appRoot: '/unrelated/application' })],
    ['saved-data location', options => ({ ...options, dataDir: '/unrelated/data' })],
    ['project location', options => ({ ...options, projectRoot: '/unrelated/projects' })],
    ['logging location', options => ({ ...options, logsDir: '/unrelated/logs' })],
    ['working directory', options => ({ ...options, workingDirectory: '/unrelated/work' })],
    ['port', options => ({ ...options, port: 64444 })],
    ['relative runtime path', options => ({ ...options, nodePath: 'node' })],
    ['non-Node executable', options => ({ ...options, nodePath: '/bin/bash' })],
  ];
  for (const [label, change] of variants) {
    await t.test(label, async t => {
      const fixture = await runtimeUpgrade(t), calls = [];
      const unrelated = launchAgentPlist(change(fixture.plistOptions));
      await writeFile(fixture.initial.agentFile, unrelated);
      await assert.rejects(installService({ ...fixture.options,
        command: async (cmd, args) => { calls.push(args[0]); return {}; }, wait: async () => {},
        fetchImpl: async () => ({ ok: true, json: async () => ({ active: null }) }),
      }));
      assert.deepEqual(calls, ['print']);
      assert.equal(await readFile(fixture.initial.agentFile, 'utf8'), unrelated);
      await assertPreservedRuntimeData(fixture);
    });
  }
  await t.test('extra server arguments', async t => {
    const fixture = await runtimeUpgrade(t), calls = [];
    const unrelated = fixture.oldPlist.replace('<string>--service</string>', '<string>--service</string><string>--extra-argument</string>');
    await writeFile(fixture.initial.agentFile, unrelated);
    await assert.rejects(installService({ ...fixture.options,
      command: async (cmd, args) => { calls.push(args[0]); return {}; }, wait: async () => {},
      fetchImpl: async () => ({ ok: true, json: async () => ({ active: null }) }),
    }));
    assert.deepEqual(calls, ['print']);
    assert.equal(await readFile(fixture.initial.agentFile, 'utf8'), unrelated);
    await assertPreservedRuntimeData(fixture);
  });
});
