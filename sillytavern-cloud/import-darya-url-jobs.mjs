import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = process.env.DARYA_IMPORT_ROOT || '/persistent/darya-source';

function normalizePath(value) {
  const raw=String(value||'').trim();
  if(!raw || raw==='.' || raw.includes('\\') || raw.includes('\0') || path.isAbsolute(raw)) {
    throw new Error('Invalid Darya import path.');
  }
  const normalized=path.posix.normalize(raw);
  if(normalized==='..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error('Darya import path traversal is not allowed.');
  }
  return normalized;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function parseJobs(jobsJson) {
  if(!String(jobsJson||'').trim()) return [];
  let jobs;
  try { jobs=JSON.parse(jobsJson); } catch { throw new Error('DARYA_IMPORT_JOBS_JSON must be valid JSON.'); }
  if(!Array.isArray(jobs)) throw new Error('DARYA_IMPORT_JOBS_JSON must be an array.');
  return jobs.map((job,index)=>{
    if(!job || typeof job!=='object' || Array.isArray(job)) throw new Error(`Invalid Darya import job at index ${index}.`);
    const url=String(job.url||'').trim();
    let parsed;
    try { parsed=new URL(url); } catch { throw new Error(`Invalid URL for Darya import job ${index}.`); }
    if(parsed.protocol!=='https:') throw new Error('Darya import URLs must use https.');
    const relativePath=normalizePath(job.path);
    const expectedSha=String(job.sha256||'').trim().toLowerCase();
    if(!/^[0-9a-f]{64}$/.test(expectedSha)) throw new Error(`Invalid sha256 for Darya import job ${index}.`);
    const expectedSize=Number(job.size);
    if(!Number.isSafeInteger(expectedSize) || expectedSize<0 || expectedSize>128*1024*1024) {
      throw new Error(`Invalid size for Darya import job ${index}.`);
    }
    return {url,relativePath,expectedSha,expectedSize};
  });
}

function atomicWrite(target,body) {
  fs.mkdirSync(path.dirname(target),{recursive:true});
  const temp=`${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp,body,{mode:0o600});
  fs.renameSync(temp,target);
}

export async function runDaryaUrlImportJobs({
  root=DEFAULT_ROOT,
  jobsJson=process.env.DARYA_IMPORT_JOBS_JSON || '',
  fetchImpl=globalThis.fetch,
}={}) {
  const jobs=parseJobs(jobsJson);
  if(!jobs.length) return {imported:0,skipped:0,total:0,files:[]};
  if(typeof fetchImpl!=='function') throw new Error('fetch implementation is required.');

  const rootResolved=path.resolve(root);
  fs.mkdirSync(rootResolved,{recursive:true});
  let imported=0, skipped=0;
  const files=[];

  for(const job of jobs) {
    const target=path.resolve(rootResolved,job.relativePath);
    if(target!==rootResolved && !target.startsWith(rootResolved+path.sep)) {
      throw new Error('Darya import path escaped root.');
    }

    if(fs.existsSync(target)) {
      const existing=fs.readFileSync(target);
      if(existing.length===job.expectedSize && sha256(existing)===job.expectedSha) {
        skipped++;
        files.push({path:job.relativePath,status:'skipped',size:existing.length,sha256:job.expectedSha});
        continue;
      }
    }

    const response=await fetchImpl(job.url,{redirect:'follow'});
    if(!response?.ok) throw new Error(`Darya import download failed for ${job.relativePath}: HTTP ${response?.status ?? 'unknown'}`);
    const body=Buffer.from(await response.arrayBuffer());
    if(body.length!==job.expectedSize) throw new Error(`Darya import size mismatch for ${job.relativePath}: expected ${job.expectedSize}, got ${body.length}`);
    const actualSha=sha256(body);
    if(actualSha!==job.expectedSha) throw new Error(`Darya import sha256 mismatch for ${job.relativePath}: expected ${job.expectedSha}, got ${actualSha}`);
    atomicWrite(target,body);
    imported++;
    files.push({path:job.relativePath,status:'imported',size:body.length,sha256:actualSha});
  }

  return {imported,skipped,total:jobs.length,files};
}

const isMain=process.argv[1] && path.resolve(process.argv[1])===path.resolve(fileURLToPath(import.meta.url));
if(isMain) {
  runDaryaUrlImportJobs()
    .then((result)=>console.log(JSON.stringify(result)))
    .catch((error)=>{
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      process.exitCode=1;
    });
}
