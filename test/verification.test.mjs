import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, symlink, realpath, readFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProjectChecks, initialVerification, summarizeVerification, validateCriterionEvidence } from '../src/verification.mjs';
import { workspaceProfile, executeWorkspaceCheck } from '../src/workspace-process.mjs';
import { runDuet } from '../src/duet.mjs';
import { execute } from '../src/process.mjs';

async function project(t) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'duet-verification-')));
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
const ok = { code: 0, stdout: 'Tests passed', stderr: '' };
test('local verification runs only declared fixed checks, without installs, lifecycle hooks, or provider secrets', async t => {
  const dir = await project(t), calls = [], updates = [];
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'test runner', build: 'build runner', posttest: 'do not call me', 'test; rm': 'no', deploy: 'no' } }));
  const previous = process.env.DUET_TEST_PRIVATE;
  process.env.DUET_TEST_PRIVATE = 'DO_NOT_INHERIT';
  t.after(() => { if (previous === undefined) delete process.env.DUET_TEST_PRIVATE; else process.env.DUET_TEST_PRIVATE = previous; });
  const checks = await runProjectChecks(dir, { timeoutMs: 999_999, runner: async (...args) => { calls.push(args); return ok; }, onCheck: values => updates.push(values) });
  assert.deepEqual(calls.map(([command, args]) => [command, ...args]), [ ['npm', '--ignore-scripts', 'run', 'test'], ['npm', '--ignore-scripts', 'run', 'build'] ]);
  assert.equal(calls[0][2].env.DUET_TEST_PRIVATE, undefined);
  assert.equal(calls[0][2].env.CI, '1');
  assert.equal(calls[0][2].timeoutMs, 120_000);
  assert.equal(calls[0][2].maxBytes, 1_048_576);
  assert.ok(checks.every(item => item.status === 'passed' && item.source === 'local'));
  assert.equal(updates[0][0].status, 'running');
});
test('missing, unsupported, malformed, or symbolic-link manifests never start project commands', async t => {
  const dir = await project(t);
  let calls = 0;
  const options = { runner: async () => { calls++; return ok; } };
  assert.equal((await runProjectChecks(dir, options))[0].status, 'not_run');
  await writeFile(path.join(dir, 'package.json'), '{}');
  assert.equal((await runProjectChecks(dir, options))[0].status, 'not_run');
  await writeFile(path.join(dir, 'package.json'), 'not json');
  assert.equal((await runProjectChecks(dir, options))[0].status, 'not_run');
  await rm(path.join(dir, 'package.json'));
  await writeFile(path.join(dir, 'other.json'), '{"scripts":{"test":"echo yes"}}');
  await symlink('other.json', path.join(dir, 'package.json'));
  assert.match((await runProjectChecks(dir, options))[0].output, /symbolic link/);
  assert.equal(calls, 0);
});
test('failed, timed-out, unavailable, and cancelled checks keep their real outcomes with bounded output', async t => {
  const dir = await project(t);
  await writeFile(path.join(dir, 'package.json'), '{"scripts":{"test":"test runner"}}');
  let checks = await runProjectChecks(dir, { runner: async () => ({code: 1, stdout: 'x'.repeat(20_000), stderr: 'failure'}) });
  assert.equal(checks[0].status, 'failed'); assert.ok(checks[0].output.length <= 12_000);
  checks = await runProjectChecks(dir, { runner: async () => { throw new Error('Helper timed out'); } });
  assert.equal(checks[0].status, 'failed'); assert.match(checks[0].output, /timed out/);
  checks = await runProjectChecks(dir, { runner: async () => { throw Object.assign(new Error('Sandbox unavailable'), { code: 'DUET_CHECK_UNAVAILABLE' }); } });
  assert.equal(checks[0].status, 'not_run');
  const controller = new AbortController(); let last;
  await assert.rejects(runProjectChecks(dir, { signal: controller.signal, onCheck: value => { last = value; }, runner: async () => { controller.abort(); throw new Error('Cancelled'); } }), /Cancelled/);
  assert.equal(last[0].status, 'cancelled');
});
test('a model claim plus a passing build never silently becomes a verified user requirement', () => {
  const initial = initialVerification(['An event survives refresh', 'Dark mode is readable']);
  assert.deepEqual(initial.criteria.map(item => item.id), ['AC1', 'AC2']);
  const result = summarizeVerification(initial.criteria, [{id:'AC1',status:'passed',evidence:'Model says the storage handler works'}], [{name:'build',status:'passed',source:'local'}]);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.criteria[0].status, 'reported_pass');
  assert.equal(result.criteria[0].source, 'model');
  assert.equal(result.criteria[1].status, 'not_tested');
  assert.throws(() => summarizeVerification(initial.criteria, [{id:'AC3',status:'passed',evidence:'unknown'}], []), /unknown requirement/);
  assert.throws(() => validateCriterionEvidence([{id:'AC1',status:'passed',evidence:'yes'},{id:'AC1',status:'passed',evidence:'yes'}]), /duplicate/);
  assert.throws(() => validateCriterionEvidence([{id:'AC1',status:'passed',evidence:''}]), /invalid/);
});
test('workspace sandbox denies networking, protected account locations, and writes to Duet records', () => {
  const profile = workspaceProfile('/tmp/project with spaces', '/tmp/check', '/tmp/fake-home');
  assert.match(profile, /\(deny default\)/);
  assert.match(profile, /\(deny network\*\)/);
  assert.match(profile, /deny file-write\*.*project with spaces\/\.duet/);
  for (const name of ['.codex', '.claude', '.ssh', '.aws', 'Library/Keychains']) assert.ok(profile.includes(`/tmp/fake-home/${name}`));
});

test('the actual Mac sandbox permits project work and rejects writes outside it and to Duet records', { skip: process.platform !== 'darwin' }, async t => {
  const base = await project(t), dir = path.join(base, 'project');
  await mkdir(path.join(dir, '.duet'), { recursive: true });
  await writeFile(path.join(dir, 'package.json'), '{"scripts":{"test":"node checks.cjs"}}');
  await writeFile(path.join(dir, 'checks.cjs'), `const fs=require('node:fs');const assert=require('node:assert/strict');
    fs.writeFileSync('result.txt','workspace write worked');
    assert.throws(()=>fs.writeFileSync('../outside.txt','not allowed'),e=>e.code==='EPERM'||e.code==='EACCES');
    assert.throws(()=>fs.writeFileSync('.duet/records.json','not allowed'),e=>e.code==='EPERM'||e.code==='EACCES');
    console.log('Workspace boundaries verified');`);
  let result;
  try { result = await executeWorkspaceCheck('npm', ['--ignore-scripts', 'run', 'test'], { cwd: dir, timeoutMs: 15_000, env: {PATH:process.env.PATH,CI:'1'} }); }
  catch (error) { if (error.code === 'DUET_CHECK_UNAVAILABLE') return t.skip(error.message); throw error; }
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Workspace boundaries verified/);
  assert.equal(await readFile(path.join(dir, 'result.txt'), 'utf8'), 'workspace write worked');
  await assert.rejects(access(path.join(base, 'outside.txt')));
  await assert.rejects(access(path.join(dir, '.duet/records.json')));
});

test('a project inside Application Support is readable without granting access to account files', { skip: process.platform !== 'darwin' }, async t => {
  const base = await project(t), fakeHome = path.join(base, 'home'), scratch = path.join(base, 'scratch');
  const dir = path.join(fakeHome, 'Library/Application Support/Duet/Projects/example');
  await mkdir(dir, { recursive: true }); await mkdir(path.join(fakeHome, '.codex'), { recursive: true }); await mkdir(scratch);
  const credential = path.join(fakeHome, '.codex/auth.json');
  await writeFile(credential, 'fake credential sentinel');
  const program = path.join(dir, 'check.cjs');
  await writeFile(program, `const fs=require('node:fs');const assert=require('node:assert/strict');
    assert.throws(()=>fs.readFileSync(${JSON.stringify(credential)},'utf8'),e=>e.code==='EPERM'||e.code==='EACCES');
    console.log('Selected project readable; account data blocked');`);
  const runtime = path.dirname(path.dirname(await realpath(process.execPath)));
  const result = await execute('/usr/bin/sandbox-exec', ['-p', workspaceProfile(dir, scratch, fakeHome, runtime), process.execPath, program], {cwd:dir,timeoutMs:15_000,env:{PATH:process.env.PATH,HOME:scratch}});
  if (/sandbox-exec: (?:sandbox_apply|Operation not permitted)/i.test(result.stderr)) return t.skip('Codex outer sandbox blocks sandbox-exec.');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Selected project readable; account data blocked/);
});

test('independent failed checks override an approved model review and are fed into a bounded repair', async t => {
  const dir = await project(t), prompts = [], progress = [];
  await writeFile(path.join(dir, 'package.json'), '{"scripts":{"test":"test runner"}}');
  const provider = async (name, args, options) => {
    const response = value => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
    if (!options.input) return response(name === 'claude' ? {loggedIn:true} : {});
    prompts.push(options.input);
    if (name === 'codex') {
      await writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify({status:'built',summary:'Built',checks:['Claimed tests passed'],requirements:[{id:'AC1',status:'passed',evidence:'A model report'}],run_instructions:'Open the app'}));
      return response({type:'turn.completed'});
    }
    const schema = args.includes('--json-schema') && JSON.parse(args[args.indexOf('--json-schema') + 1]);
    if (schema?.properties?.complexity) return response({structured_output:{complexity:'focused',collaboration:'single-builder',reason:'One change',plan:'Build',acceptanceCriteria:['Feature works']}});
    if (schema) return response({structured_output:{verdict:'approved',summary:'Looks good',findings:[]}});
    return response({result:'Implemented'});
  };
  const result = await runDuet({project:dir,prompt:'Build feature',optimization:'economy',maxCalls:10,maxRounds:2,runner:provider,
    verificationRunner:async () => ({code:1,stdout:'Expected saved event, received nothing',stderr:''}),onState:state=>progress.push(state)});
  assert.equal(result.status,'needs_attention');
  assert.equal(result.rounds.length,2);
  assert.equal(result.verification.status,'failed');
  assert.equal(result.rounds[0].review.verdict,'changes_requested');
  assert.ok(prompts.some(value=>value.includes('PRIOR INDEPENDENT CHECKS:') && value.includes('Expected saved event')));
  assert.ok(progress.some(state=>state.status==='verifying' && state.verification.criteria[0].id==='AC1'));
});
