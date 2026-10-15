import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomInt } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
export const benchmarkTasks = [
  ['reading-list','Build a reading list with add, complete, delete, and filters. Save it locally.', ['Add a title and see it immediately','Reject blank titles','Complete and filter books','Preserve books after refresh']],
  ['club-calendar','Build a local club calendar with event creation, editing, deletion, and a chronological agenda.', ['Create dated events','Edit one without duplicating it','Delete the correct event','Preserve events after refresh']],
  ['expense-summary','Build a personal expense tracker with categories and a monthly total. Store entries locally.', ['Accept positive amounts and a date','Reject invalid amounts','Compute exact total to cents','Retain entries after refresh']],
  ['flashcards','Build a flashcard study app with add, reveal answer, next card, and a progress indicator.', ['Create and study multiple cards','Hide each answer until reveal','Handle an empty deck','Preserve the deck after refresh']],
  ['recipe-search','Build a recipe collection with title, ingredients, search, and local storage.', ['Add multiple recipes','Search title case-insensitively','Show a clear no-results state','Preserve recipes after refresh']],
  ['habit-grid','Build a weekly habit tracker with daily toggles, a weekly total, and local storage.', ['Add habits','Toggle a day on and off','Count each marked day once','Persist the same calendar dates after refresh']],
  ['form-validation','Build a contact form demo with name, email, message, inline validation, and a local success state. No real sending.', ['Reject empty required fields','Reject malformed email','Preserve entries when validation fails','Show success only for valid input']],
  ['accessible-dialog','Build a page with an accessible settings dialog, a theme preference, and keyboard interaction.', ['Open and close the dialog','Escape closes it','Keyboard focus remains in open dialog and returns on close','Theme preference survives refresh']],
  ['responsive-gallery','Build an image gallery with filters, a detail view, and a useful mobile layout. Use bundled or inline image assets.', ['Filter changes visible cards','Detail view opens the chosen item','Close detail using keyboard','No horizontal overflow at 375px']],
  ['undo-list','Build a notes list with create, edit, delete, and undo for the last deletion.', ['Create and edit the selected note','Delete only the selected note','Undo restores its contents','Saved notes survive refresh']],
  ['csv-import','Build a local CSV preview tool for name,email rows using pasted text. Do not upload data.', ['Parse a header and multiple rows','Handle quoted commas','Show malformed input clearly','Render input as text, never executable HTML']],
  ['timer','Build a countdown timer with start, pause, resume, reset, and an accessible completion state.', ['Count down from entered duration','Pause without losing remaining time','Resume without duplicate timers','Reset and completion leave controls consistent']],
].map(([id,prompt,criteria])=>({id,prompt,criteria}));
const systems = ['claude','codex','duet'];
export async function initializeBenchmark(destination) {
  destination=path.resolve(destination);
  // Exclusive directory: never mix results or overwrite existing user projects.
  await mkdir(destination, {recursive:false,mode:0o700});
  const assignments=[];
  for(const task of benchmarkTasks) {
    const order=[...systems];
    for(let i=order.length-1;i>0;i--){const j=randomInt(i+1);[order[i],order[j]]=[order[j],order[i]];}
    for(const system of order){
      const sample=randomUUID().slice(0,8), folder=path.join(destination,sample);
      await mkdir(path.join(folder,'project'),{recursive:true});
      const request=`${task.prompt}\nUse vanilla HTML, CSS, and JavaScript with an index.html entry point. No external dependencies, network services, or deployment.\n\nAcceptance checks:\n${task.criteria.map((c,i)=>`${i+1}. ${c}`).join('\n')}\n`;
      await writeFile(path.join(folder,'REQUEST.txt'),request);
      await writeFile(path.join(folder,'score.json'),JSON.stringify({sample,taskId:task.id,criteria:task.criteria.map(text=>({text,passed:null,evidence:''})),minutes:null,interventions:null,reportedTokens:null,notes:''},null,2)+'\n');
      assignments.push({sample,taskId:task.id,system});
    }
  }
  await writeFile(path.join(destination,'assignments.json'),JSON.stringify({version:1,createdAt:new Date().toISOString(),assignments},null,2)+'\n',{mode:0o600});
  await writeFile(path.join(destination,'READ ME.txt'),'Duet comparison kit. No AI calls have been made.\n\nOperator: use assignments.json to run each REQUEST.txt through its assigned system in that sample project folder. Keep the same time and usage limits; record exact versions/models and all interventions in a separate operator log. Do not give an assistant another system\'s output.\n\nEvaluator: receive only the sample folders, without assignments.json or operator log. Open each result, perform each acceptance check, and fill score.json using true/false and concrete evidence. Missing results are not passes. Record elapsed minutes and human interventions from operator logs after blind scoring. Leave token counts null when unavailable; subscription credits are not interchangeable.\n\nRun benchmark.mjs report against this folder after scoring. Only task groups scored for all three systems enter the comparison. Repeat with fresh folders before drawing conclusions.\n');
  return {destination,trials:assignments.length,tasks:benchmarkTasks.length,message:'Prepared trials; no model usage consumed.'};
}
export function summarizeBenchmark(records){
  const complete=records.filter(row=>Array.isArray(row.criteria)&&row.criteria.length===4&&row.criteria.every(c=>typeof c.passed==='boolean'&&typeof c.evidence==='string'&&c.evidence.trim())&&Number.isFinite(row.minutes)&&row.minutes>=0&&Number.isInteger(row.interventions)&&row.interventions>=0);
  const matched=benchmarkTasks.filter(task=>systems.every(system=>complete.some(row=>row.taskId===task.id&&row.system===system))).map(task=>task.id);
  const results=systems.map(system=>{
    const rows=complete.filter(row=>row.system===system&&matched.includes(row.taskId));
    return {system,trials:rows.length,requirementsPassed:rows.reduce((s,r)=>s+r.criteria.filter(c=>c.passed).length,0),requirementsTotal:rows.reduce((s,r)=>s+r.criteria.length,0),fullyWorking:rows.filter(r=>r.criteria.every(c=>c.passed)).length,minutes:rows.reduce((s,r)=>s+r.minutes,0),interventions:rows.reduce((s,r)=>s+r.interventions,0),trialsWithTokenData:rows.filter(r=>Number.isSafeInteger(r.reportedTokens)&&r.reportedTokens>=0).length,reportedTokens:rows.reduce((s,r)=>s+(Number.isSafeInteger(r.reportedTokens)&&r.reportedTokens>=0?r.reportedTokens:0),0)};
  });
  return {matchedTasks:matched.length,scoredTrials:complete.length,results,note:'Pilot evidence only. Unscored trials are excluded, never treated as successes. Token totals are not comparable subscription credits. Use repeated runs with fixed limits and blind scoring before making quality or savings claims.'};
}
export async function benchmarkReport(folder){
  const manifest=JSON.parse(await readFile(path.join(folder,'assignments.json'),'utf8'));
  if(manifest.version!==1||!Array.isArray(manifest.assignments)||manifest.assignments.length!==36)throw new Error('Invalid comparison manifest.');
  const seen=new Set(),records=[];
  for(const a of manifest.assignments){
    if(!/^[a-f0-9]{8}$/.test(a.sample)||!systems.includes(a.system)||!benchmarkTasks.some(t=>t.id===a.taskId)||seen.has(`${a.taskId}:${a.system}`))throw new Error('Invalid or duplicate comparison assignment.');
    seen.add(`${a.taskId}:${a.system}`);
    const score=JSON.parse(await readFile(path.join(folder,a.sample,'score.json'),'utf8'));
    const expected=benchmarkTasks.find(task=>task.id===a.taskId);
    if(score.sample!==a.sample||score.taskId!==a.taskId||JSON.stringify(score.criteria?.map(c=>c.text))!==JSON.stringify(expected.criteria))throw new Error('Scorecard does not match its assigned requirements.');
    records.push({...score,system:a.system});
  }
  return summarizeBenchmark(records);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const [command,folder]=process.argv.slice(2);if(!folder||!['init','report'].includes(command))throw new Error('Usage: node src/benchmark.mjs init|report /absolute/comparison-folder');console.log(JSON.stringify(command==='init'?await initializeBenchmark(folder):await benchmarkReport(folder),null,2));}catch(error){console.error(error.message);process.exitCode=1;}
}
