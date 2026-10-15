import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { outcomeSummary } from '../src/outcomes.mjs';
import { initializeBenchmark, benchmarkReport } from '../src/benchmark.mjs';
test('outcomes distinguish absent feedback and unknown usage from success or measured zero',()=>{
  const result=outcomeSummary([{mode:'build',finishedAt:'2026-10-08T01:00:00Z',startedAt:'2026-10-08T00:59:00Z',coordinator:{mode:'quality',calls:[{},{}],callsWithUsage:0,reportedTokens:0}},{mode:'build',finishedAt:'2026-10-08T01:00:00Z',coordinator:{mode:'quality',calls:[],callsWithUsage:1,reportedTokens:120},feedback:{outcome:'needs_fixes'}},{mode:'ask',finishedAt:'2026-10-08T01:00:00Z',coordinator:{mode:'quality'}}]);
  const quality=result.modes[0];assert.equal(quality.builds,2);assert.equal(quality.feedbackCount,1);assert.equal(quality.works,0);assert.equal(quality.needsFixes,1);assert.equal(quality.buildsWithUsage,1);assert.equal(quality.reportedTokens,120);assert.match(result.note,/cannot establish/);
});
test('benchmark prepares identical isolated prompts, never counts missing scores, and compares matched task groups',async t=>{
  const tmp=await mkdtemp(path.join(os.tmpdir(),'duet-benchmark-test-'));t.after(()=>rm(tmp,{recursive:true,force:true}));
  const folder=path.join(tmp,'comparison'),setup=await initializeBenchmark(folder);assert.equal(setup.trials,36);
  await assert.rejects(initializeBenchmark(folder),{code:'EEXIST'});
  assert.equal((await benchmarkReport(folder)).matchedTasks,0);
  const map=JSON.parse(await readFile(path.join(folder,'assignments.json'))).assignments;
  const group=map.filter(row=>row.taskId==='reading-list');
  const prompts=await Promise.all(group.map(row=>readFile(path.join(folder,row.sample,'REQUEST.txt'),'utf8')));assert.equal(new Set(prompts).size,1);
  for(const row of group){const file=path.join(folder,row.sample,'score.json'),score=JSON.parse(await readFile(file));score.criteria=score.criteria.map(c=>({...c,passed:row.system!=='codex',evidence:'Manually exercised the corresponding interaction.'}));score.minutes=5;score.interventions=1;await writeFile(file,JSON.stringify(score));}
  const report=await benchmarkReport(folder);assert.equal(report.matchedTasks,1);assert.equal(report.results.find(r=>r.system==='duet').fullyWorking,1);assert.equal(report.results.find(r=>r.system==='codex').fullyWorking,0);assert.equal(report.results[0].trialsWithTokenData,0);
  map[0].sample='../escape';await writeFile(path.join(folder,'assignments.json'),JSON.stringify({version:1,assignments:map}));await assert.rejects(benchmarkReport(folder),/Invalid/);
});
