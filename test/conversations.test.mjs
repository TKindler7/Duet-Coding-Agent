import test from 'node:test';
import assert from 'node:assert/strict';
import { askDuet, conversationPrompt, summarizeJob } from '../src/conversations.mjs';

test('Ask mode sends only read tools and returns a conversational answer', async () => {
  let invocation;
  const result = await askDuet({project:'/tmp',prompt:'Explain this project',runner:async (command,args,options)=>{
    invocation={command,args,options};
    return {code:0,stdout:JSON.stringify({result:'Here is how it works.'}),stderr:''};
  }});
  assert.equal(result.answer,'Here is how it works.');
  assert.equal(result.status,'answered');
  assert.equal(invocation.args[invocation.args.indexOf('--tools')+1],'Read,Glob,Grep');
  assert.match(invocation.options.input,/do not modify files/);
});
test('Ask errors do not appear as successful assistant answers', async () => {
  await assert.rejects(askDuet({project:'/tmp',prompt:'Explain',runner:async()=>({code:0,stdout:JSON.stringify({is_error:true,result:'Login expired'}),stderr:''})}),/Login expired/);
  await assert.rejects(askDuet({project:'/tmp',prompt:'Explain',runner:async()=>({code:0,stdout:'broken',stderr:''})}),/unreadable/);
});
test('long chat context retains original requirements and latest request with a visible truncation marker', () => {
  const history=[{role:'user',text:'Original requirements'},...Array.from({length:20},(_,i)=>({role:'assistant',text:`Exchange ${i}: `+'x'.repeat(10000)}))];
  const input=conversationPrompt(history,'Now add search');
  assert.match(input,/Original requirements/);
  assert.match(input,/Exchange 19/);
  assert.match(input,/older exchanges are omitted/);
  assert.ok(input.endsWith('Now add search'));
  assert.ok(input.length<112000);
});
test('interrupted or incomplete turns are never presented as finished builds', () => {
  assert.match(summarizeJob({status:'interrupted'}),/interrupted/);
  assert.match(summarizeJob({status:'needs_attention',rounds:[]}),/round limit/);
  assert.match(summarizeJob({status:'cancelled'}),/Stopped/);
});
