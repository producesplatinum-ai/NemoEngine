import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function gitBlobSha1(value) {
  const bytes = Buffer.byteLength(value, 'utf8');
  return createHash('sha1').update(`blob ${bytes}\0`).update(value, 'utf8').digest('hex');
}

/** Validate Nemo's own emit-dir manifest against the exact text supplied to the provider. */
export function buildNemoModuleEvidence(manifest, instructions) {
  if (manifest?.schemaVersion !== 'nemo-chatgpt-runtime-emission/v1' ||
      !Array.isArray(manifest.orderedEmittedIds) || !Array.isArray(manifest.omittedModules)) {
    throw new Error('Invalid Nemo emission manifest');
  }
  const text = String(instructions ?? '');
  const sha = sha256(text);
  if (sha !== manifest.instructionSha256) throw new Error('Nemo emission SHA-256 mismatch');
  if (Array.from(text).length !== manifest.instructionChars) {
    throw new Error('Nemo emission character count mismatch');
  }
  const modules = [
    ...manifest.orderedEmittedIds.map((id) => ({ id: String(id), status: 'emitted' })),
    ...manifest.omittedModules.map((m) => ({ id: String(m.id), status: String(m.reason) })),
  ];
  if (modules.some((m) => !m.id || !m.status)) throw new Error('Invalid Nemo module identifier');
  return { schemaVersion: 1, verified: true, sha256: sha, modules };
}

/**
 * Read a privately provisioned skills bundle from a LOCAL path only.
 * GitHub credentials and diary pages are never requested or fetched by this helper.
 * Fails closed on invalid provenance; no private skill text is included in evidence.
 */
export async function loadVerifiedSexSkillsBundle(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('SexSkills bundle path is required');
  }
  const data = await readFile(filePath, 'utf8');
  if (Buffer.byteLength(data, 'utf8') > 150_000) throw new Error('SexSkills bundle too large');
  const bundle = JSON.parse(data);
  if (bundle?.schemaVersion !== 1 || !Array.isArray(bundle.skills) ||
      bundle.skills.length === 0 || bundle.skills.length > 4) {
    throw new Error('Invalid SexSkills bundle schema or skill count');
  }
  const whitelist = new Set([
    'sex','anal','blowjob','handjob','cunnilingus','fingering','foreplay','breast-play',
    'masturbation','kissing','climax','cum-play','squirting','erotic-massage',
    'watersports','bdsm','roleplay','cuckold-cuckquean','infidelity','boundaries',
    'aftercare','arousal-system','exhibitionism-voyeurism','verbal-erotica',
    'group-sex','seduction','sex-toys','lesbian-gay','harem','character-creation',
    'skill-style-guide','monster-tentacle','incest',
  ]);
  const seen = new Set(), evidence = [], contents = [];
  for (const skill of bundle.skills) {
    const name = String(skill?.name || '');
    const content = skill?.content;
    if (!whitelist.has(name) || seen.has(name) || typeof content !== 'string' ||
        !content.trim() || Array.from(content).length > 30_000 ||
        !/^[0-9a-f]{40}$/.test(String(skill.gitBlobSha1 || ''))) {
      throw new Error('Invalid or duplicate SexSkill in bundle');
    }
    seen.add(name);
    const actual = gitBlobSha1(content);
    if (actual !== skill.gitBlobSha1) throw new Error(`Git blob SHA mismatch for ${name}`);
    evidence.push({name, status:'verified-and-included',gitBlobSha1:actual,chars:Array.from(content).length});
    contents.push(`## Verified SexSkill: ${name}\n${content}`);
  }
  return {instructions:contents.join('\n\n'),evidence};
}
