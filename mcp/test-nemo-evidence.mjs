import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildNemoModuleEvidence,loadVerifiedSexSkillsBundle} from './nemo-evidence.mjs';
const hash=(s)=>createHash('sha256').update(s).digest('hex');
const gitBlob=(s)=>createHash('sha1').update(`blob ${Buffer.byteLength(s)}\0`).update(s).digest('hex');
test('manifest exposes exact emitted and omitted modules with matching instruction SHA',()=>{
  const instructions='compiled payload';
  const manifest={schemaVersion:'nemo-chatgpt-runtime-emission/v1',instructionSha256:hash(instructions),instructionChars:Array.from(instructions).length,orderedEmittedIds:['v11-176-nsfw-dirty-talk','output-guard'],omittedModules:[{id:'v11-179-nsfw-moans-sfx',reason:'omitted-state-only'}]};
  const e=buildNemoModuleEvidence(manifest,instructions);
  assert.equal(e.verified,true);
  assert.equal(e.sha256,hash(instructions));
  assert.deepEqual(e.modules,[{id:'v11-176-nsfw-dirty-talk',status:'emitted'},{id:'output-guard',status:'emitted'},{id:'v11-179-nsfw-moans-sfx',status:'omitted-state-only'}]);
});
test('module evidence rejects altered instructions',()=>{
  assert.throws(()=>buildNemoModuleEvidence({schemaVersion:'nemo-chatgpt-runtime-emission/v1',instructionSha256:hash('a'),instructionChars:1,orderedEmittedIds:[],omittedModules:[]},'b'),/SHA-256 mismatch/);
});
test('private skills bundle verifies Git blob SHA and emits provenance without content',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'nemo-test-'));try{
 const skillText='# ROLEPLAY\nTest training text';const file=path.join(dir,'private-skills.json');
 await writeFile(file,JSON.stringify({schemaVersion:1,skills:[{name:'roleplay',content:skillText,gitBlobSha1:gitBlob(skillText)}]}));
 const bundle=await loadVerifiedSexSkillsBundle(file);
 assert.equal(bundle.instructions.includes(skillText),true);
 assert.deepEqual(bundle.evidence,[{name:'roleplay',status:'verified-and-included',gitBlobSha1:gitBlob(skillText),chars:Array.from(skillText).length}]);
 assert.equal(JSON.stringify(bundle.evidence).includes(skillText),false);
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('private skills bundle fails closed on incorrect source hash',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'nemo-test-'));try{
 const file=path.join(dir,'wrong.json');await writeFile(file,JSON.stringify({schemaVersion:1,skills:[{name:'roleplay',content:'# TEST',gitBlobSha1:'0'.repeat(40)}]}));
 await assert.rejects(loadVerifiedSexSkillsBundle(file),/Git blob SHA mismatch/);
 }finally{await rm(dir,{recursive:true,force:true})}
});