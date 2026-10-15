import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCoordinator, reportedUsage, modelUnavailable, validatePlan } from '../src/coordinator.mjs';
import { runDuet } from '../src/duet.mjs';
import { askDuet } from '../src/conversations.mjs';
const plan = { complexity: 'focused', collaboration: 'single-builder', reason: 'One small component needs a focused edit.', plan: 'Fix the component and test it.', acceptanceCriteria: ['Component works'] };
const response = value => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
function fixture(calls, { failModel = false, quota = false, neverApprove = false, malformedPlan = false } = {}) {
  let builds = 0, failed = false;
  return async (agent, args, options) => {
    if (!options.input) return agent === 'claude' ? response({ loggedIn: true }) : response({});
    const call = { agent, args, input: options.input }; calls.push(call);
    if (failModel && !failed && args.includes('--model')) { failed = true; return { code: 1, stdout: '', stderr: quota ? 'Usage limit reached' : 'Requested model not available' }; }
    if (agent === 'codex') {
      builds++;
      await writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify({status:'built',summary:'Updated component',checks:['Node check: passed'],requirements:[{id:'AC1',status:'passed',evidence:'Inspected the component in the fixture.'}],run_instructions:'Open index.html'}));
      return response({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 100, output_tokens: 200 } });
    }
    const schema = args.includes('--json-schema') && JSON.parse(args[args.indexOf('--json-schema') + 1]);
    const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 };
    if (schema?.properties?.complexity) return response({structured_output:malformedPlan ? {} : plan,usage});
    if (schema) return response({ structured_output: {verdict:builds > 1 && !neverApprove ? 'approved':'changes_requested',summary:'Inspected component',findings:builds > 1 && !neverApprove ? []:['Fix missing empty state']},usage });
    return response({ result: 'Implemented the component.', usage });
  };
}
async function project(t) { const folder = await mkdtemp(path.join(os.tmpdir(), 'duet-routing-')); t.after(()=>rm(folder,{recursive:true,force:true})); return folder; }

test('quality is the default, and task assessment cannot select models or widen permissions', () => {
  const c = createCoordinator(); c.assess({...plan,model:'arbitrary',command:'unsafe'});
  assert.equal(c.snapshot().mode,'quality'); assert.equal(c.route('codex','build').model,'gpt-6-astra');
  assert.equal(c.route('claude','review').model,'opus'); assert.equal(c.paired(1),true);
  assert.equal(c.snapshot().assessment.model,undefined);
  assert.throws(()=>createCoordinator({optimization:'anything'}));
  assert.throws(()=>createCoordinator({maxCalls:0})); assert.throws(()=>validatePlan({}));
});
test('economy uses Luna for focused work and escalates after review; complex work starts stronger', () => {
  const c=createCoordinator({optimization:'economy'}); c.assess(plan);
  assert.equal(c.route('codex','build',1).model,'gpt-6-luna');
  assert.equal(c.route('codex','build',2).model,'gpt-6.1-sol'); assert.equal(c.paired(1),false);
  c.assess({...plan,complexity:'complex'}); assert.equal(c.route('codex','build',1).model,'gpt-6.1-sol');
});
test('usage does not double-count Codex cached input; missing counts stay unknown', () => {
  assert.equal(reportedUsage('codex',JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:80,output_tokens:20}})).total,120);
  assert.equal(reportedUsage('claude',JSON.stringify({usage:{input_tokens:10,output_tokens:20,cache_read_input_tokens:100,cache_creation_input_tokens:40}})).total,170);
  assert.equal(reportedUsage('claude','{}'),null);
  const aggregate = reportedUsage('claude', JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {
    'claude-opus': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40 },
    'claude-sonnet': { inputTokens: 5, outputTokens: 6 },
  } }));
  assert.equal(aggregate.total, 111);
  assert.deepEqual(aggregate.actualModels, ['claude-opus', 'claude-sonnet']);
  assert.equal(reportedUsage('codex','unparseable'),null);
  assert.equal(reportedUsage('claude',JSON.stringify({usage:{input_tokens:-1,output_tokens:2}})),null);
});
test('call cap includes failed attempts and token threshold stops only before the next step', () => {
  const c=createCoordinator({maxCalls:2,tokenLimit:100});
  const call=c.begin(c.route('claude','plan'),'plan');
  c.finish(call,response({usage:{input_tokens:150,output_tokens:20}}),'failed');
  assert.equal(c.snapshot().reportedTokens,170); assert.equal(c.snapshot().calls.length,1);
  assert.throws(()=>c.begin(c.route('claude','review'),'review'),error=>error.code==='DUET_BUDGET');
});
test('availability fallback never retries quota or organization restrictions', () => {
  assert.equal(modelUnavailable({stderr:'Model not available'}),true);
  for (const stderr of ['Usage limit reached','Model not available due to organization policy','Rate limit: model not available','Permission denied']) assert.equal(modelUnavailable({stderr}),false);
});
test('economy executes fewer steps and escalates a failed review without skipping independent review', async t => {
  const calls=[]; const result=await runDuet({project:await project(t),prompt:'Fix empty state',optimization:'economy',runner:fixture(calls)});
  assert.equal(result.status,'needs_attention');
  assert.deepEqual(calls.map(c=>c.agent),['claude','codex','claude','codex','claude']);
  assert.equal(calls[1].args[calls[1].args.indexOf('--model')+1],'gpt-6-luna');
  assert.equal(calls[3].args[calls[3].args.indexOf('--model')+1],'gpt-6.1-sol');
  assert.equal(result.coordinator.calls.length,5); assert.equal(result.coordinator.callsWithUsage,5);
  assert.ok(result.coordinator.reportedTokens>0);
});
test('quality keeps complementary coding and review, and saves the full routing record', async t => {
  const calls=[]; const result=await runDuet({project:await project(t),prompt:'Build component',runner:fixture(calls)});
  assert.equal(result.status,'needs_attention'); assert.equal(calls.length,7);
  assert.ok(calls.filter(c=>c.agent==='codex').every(c=>c.args.includes('gpt-6-astra')));
  const saved=JSON.parse(await readFile(path.join(result.runDir,'state.json')));
  assert.equal(saved.coordinator.calls.length,7); assert.equal(saved.coordinator.mode,'quality');
});
test('exhausted budget and malformed planning stop honestly and release the project lock', async t => {
  for (const options of [{maxCalls:2},{maxCalls:2,malformedPlan:true},{maxCalls:10,tokenLimit:1}]) {
    const dir=await project(t),calls=[];
    const run=()=>runDuet({project:dir,prompt:'Build',...options,runner:fixture(calls,options)});
    if(options.malformedPlan) await assert.rejects(run(),/invalid plan/);
    else { const result=await run();assert.equal(result.status,'needs_attention');assert.match(result.coordinator.stopReason,/limit|threshold/); }
    assert.ok(calls.length<=options.maxCalls); await assert.rejects(access(path.join(dir,'.duet/active.lock')));
  }
});
test('unavailable model falls back once, records it, and fallback consumes budget', async t => {
  const calls=[]; const result=await runDuet({project:await project(t),prompt:'Build',maxCalls:1,runner:fixture(calls,{failModel:true})});
  assert.equal(result.status,'needs_attention'); assert.equal(calls.length,1); assert.equal(result.coordinator.calls[0].status,'failed');
  const calls2=[];const result2=await runDuet({project:await project(t),prompt:'Build',runner:fixture(calls2,{failModel:true})});
  assert.equal(result2.status,'needs_attention');assert.ok(!calls2[1].args.includes('--model'));assert.ok(result2.coordinator.decisions.some(d=>d.reason.includes('unavailable')));
});
test('quota errors do not trigger retries, and persistent findings stop a non-progressing loop', async t => {
  const calls=[]; await assert.rejects(runDuet({project:await project(t),prompt:'Build',runner:fixture(calls,{failModel:true,quota:true})})); assert.equal(calls.length,1);
  const result=await runDuet({project:await project(t),prompt:'Build',maxRounds:10,maxCalls:40,runner:fixture([],{neverApprove:true})});
  assert.equal(result.status,'needs_attention');assert.equal(result.rounds.length,3);assert.match(result.error,/not making progress/);
});
test('Ask mode uses the chosen quality preset and preserves read-only permissions', async t => {
  const calls=[];const result=await askDuet({project:await project(t),prompt:'Explain it',optimization:'quality',runner:fixture(calls)});
  assert.equal(result.status,'answered');assert.equal(calls.length,1);assert.ok(calls[0].args.includes('opus'));
  assert.equal(calls[0].args[calls[0].args.indexOf('--tools')+1],'Read,Glob,Grep');assert.equal(result.coordinator.calls.length,1);
});
