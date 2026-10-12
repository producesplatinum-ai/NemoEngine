import { createHash } from 'node:crypto';

// The portable runtime's emission manifest is bound to its exact instructions.
// Only module identifiers and omission reasons leave this boundary, never prompt text.
export function verifiedModuleEvidence(manifest, instructions) {
  if (!manifest || manifest.schemaVersion !== 'nemo-chatgpt-runtime-emission/v1') {
    throw new Error('Unexpected Nemo emission manifest schema.');
  }
  const sha256 = createHash('sha256').update(instructions, 'utf8').digest('hex');
  const characters = Array.from(instructions).length;
  if (manifest.instructionSha256 !== sha256 || manifest.instructionChars !== characters) {
    throw new Error('Nemo emission manifest does not match compiled instructions.');
  }
  if (!Array.isArray(manifest.orderedEmittedIds) || !Array.isArray(manifest.omittedModules)) {
    throw new Error('Nemo emission manifest is missing module evidence.');
  }
  const emitted = manifest.orderedEmittedIds.map(id => {
    if (typeof id !== 'string' || !id.trim()) throw new Error('Invalid emitted Nemo module id.');
    return id;
  });
  const omitted = manifest.omittedModules.map(m => {
    if (!m || typeof m.id !== 'string' || !m.id.trim() || typeof m.reason !== 'string' || !m.reason.trim()) {
      throw new Error('Invalid omitted Nemo module evidence.');
    }
    return { id: m.id, reason: m.reason };
  });
  if (new Set([...emitted, ...omitted.map(m => m.id)]).size !== emitted.length + omitted.length) {
    throw new Error('Duplicate Nemo module identifier in emission manifest.');
  }
  return {
    schema: 'nemo-module-evidence/v1',
    profile: String(manifest.profile?.character_id ?? manifest.profile ?? ''),
    instructionsSha256: sha256,
    instructionChars: characters,
    emittedModuleIds: emitted,
    omittedModules: omitted,
    // This is deliberately not proof of separately loaded Diary SexSkills.
    externalSexSkills: 'not-attached',
  };
}
