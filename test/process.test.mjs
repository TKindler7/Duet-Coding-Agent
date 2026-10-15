import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { execute } from '../src/process.mjs';

const child = (source, options) => execute(process.execPath, ['-e', source], options);

test('timeout options reject invalid or overflowing values before starting a helper', async () => {
  for (const name of ['timeoutMs', 'idleTimeoutMs']) {
    for (const value of [0, -1, NaN, Infinity, '100', null, 2_147_483_648]) {
      await assert.rejects(execute('/not/a/real/helper', [], { [name]: value }), error => {
        assert.ok(error instanceof RangeError);
        assert.match(error.message, new RegExp(name));
        return true;
      });
    }
  }
});

test('stdout and stderr activity let a helper run longer than its idle window', async t => {
  for (const stream of ['stdout', 'stderr']) await t.test(stream, async () => {
    const output = [];
    const result = await child(`
      process.${stream}.write('started\\n');
      const interval = setInterval(() => process.${stream}.write('working\\n'), 30);
      setTimeout(() => { clearInterval(interval); process.${stream}.write('finished\\n'); }, 1400);
    `, { timeoutMs: 5000, idleTimeoutMs: 1000, onOutput: event => output.push(event) });
    assert.equal(result.code, 0);
    assert.match(result[stream], /started\nworking\n/);
    assert.match(result[stream], /finished\n$/);
    assert.ok(output.length > 3);
    assert.ok(output.every(event => event.stream === stream && Buffer.isBuffer(event.chunk)));
    assert.equal(Buffer.concat(output.map(event => event.chunk)).toString(), result[stream]);
  });
});

test('silence triggers the idle timeout and retains the partial output', async () => {
  await assert.rejects(child(`process.stdout.write('started\\n'); setInterval(() => {}, 1000);`, {
    timeoutMs: 5000, idleTimeoutMs: 1000,
  }), error => {
    assert.equal(error.code, 'DUET_IDLE_TIMEOUT');
    assert.match(error.message, /timed out.*without output/);
    assert.equal(error.result.stdout, 'started\n');
    assert.equal(error.result.signal, 'SIGTERM');
    return true;
  });
});

test('the hard deadline still stops helpers that keep producing output', async () => {
  await assert.rejects(child(`
    process.stdout.write('started\\n');
    setInterval(() => process.stdout.write('working\\n'), 25);
  `, { timeoutMs: 1800, idleTimeoutMs: 1000 }), error => {
    assert.equal(error.code, 'DUET_TIMEOUT');
    assert.match(error.message, /timed out/);
    assert.match(error.result.stdout, /working/);
    assert.equal(error.result.signal, 'SIGTERM');
    return true;
  });
});

test('helpers without an idle deadline can be silent and retain the existing hard-timeout behavior', async () => {
  const result = await child(`setTimeout(() => process.stdout.write('done'), 120);`, { timeoutMs: 4000 });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'done');
  await assert.rejects(child('setInterval(() => {}, 1000)', { timeoutMs: 150 }), { code: 'DUET_TIMEOUT' });
});

test('throwing, rejecting, and mutating output observers cannot damage captured output', async t => {
  for (const mode of ['throws', 'rejects', 'mutates']) await t.test(mode, async () => {
    const streams = new Set();
    const result = await child(`process.stdout.write('safe stdout'); process.stderr.write('safe stderr');`, {
      timeoutMs: 4000,
      onOutput({ stream, chunk }) {
        streams.add(stream);
        if (mode === 'throws') throw new Error('Observer stopped');
        if (mode === 'rejects') return Promise.reject(new Error('Observer disconnected'));
        chunk.fill(0);
      },
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'safe stdout');
    assert.equal(result.stderr, 'safe stderr');
    assert.deepEqual(streams, new Set(['stdout', 'stderr']));
    await delay(0);
  });
});

test('output bounds still stop a noisy helper even while output observers are attached', async () => {
  let events = 0;
  await assert.rejects(child(`process.stdout.write('x'.repeat(10000)); setInterval(() => {}, 1000);`, {
    maxBytes: 100, timeoutMs: 5000, idleTimeoutMs: 1000,
    onOutput: () => { events++; },
  }), error => {
    assert.match(error.message, /output exceeded/);
    assert.ok(Buffer.byteLength(error.result.stdout) <= 100);
    return true;
  });
  assert.equal(events, 0);
});

test('cancellation is classified before spawn and during an active helper', async () => {
  const before = new AbortController(); before.abort();
  await assert.rejects(execute('/not/a/real/helper', [], { signal: before.signal }), { code: 'DUET_CANCELLED' });
  const during = new AbortController();
  await assert.rejects(child(`process.stdout.write('ready\\n'); setInterval(() => {}, 1000);`, {
    signal: during.signal, timeoutMs: 5000, idleTimeoutMs: 1000,
    onOutput: () => during.abort(),
  }), error => {
    assert.equal(error.code, 'DUET_CANCELLED');
    assert.match(error.message, /Cancelled/);
    assert.equal(error.result.stdout, 'ready\n');
    return true;
  });
});

test('cancellation escalates to kill descendants even after their parent exits', { skip: process.platform === 'win32' }, async () => {
  const controller = new AbortController();
  let descendantPid, pidOutput = '';
  const source = `
    const { spawn } = require('node:child_process');
    const source = 'process.on("SIGTERM", () => {}); process.stdout.write("descendant-ready\\\\n"); setInterval(() => {}, 1000);';
    const descendant = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'inherit'] });
    descendant.stdout.once('data', () => process.stdout.write(String(descendant.pid) + '\\n'));
    setInterval(() => {}, 1000);
  `;
  try {
    await assert.rejects(child(source, {
      signal: controller.signal, timeoutMs: 5000,
      onOutput({ stream, chunk }) {
        if (stream === 'stdout' && !descendantPid) {
          pidOutput += chunk.toString();
          if (!pidOutput.includes('\n')) return;
          descendantPid = Number(pidOutput.split('\n')[0]);
          if (Number.isSafeInteger(descendantPid) && descendantPid > 0) controller.abort();
        }
      },
    }), error => {
      assert.equal(error.code, 'DUET_CANCELLED');
      assert.ok(descendantPid > 0);
      return true;
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(descendantPid, 0); }
      catch (error) { if (error.code === 'ESRCH') return; throw error; }
      await delay(20);
    }
    assert.fail('The cancelled helper left its descendant running.');
  } finally {
    controller.abort();
    if (descendantPid > 0) { try { process.kill(descendantPid, 'SIGKILL'); } catch { /* Already stopped. */ } }
  }
});
