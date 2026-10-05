import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { sanitizeOutput } from '../scripts/nemo-chatgpt-runtime.mjs';

const RUNTIME_PATH = fileURLToPath(
  new URL('../scripts/nemo-chatgpt-runtime.mjs', import.meta.url),
);
const DEFAULT_PROFILE = '100001';
const MAX_TRANSCRIPT_CHARS = 16_000;
const MAX_SHORT_TERM_CHARS = 8_000;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function tailByCodePoints(value, limit) {
  const chars = Array.from(String(value || ''));
  if (chars.length <= limit) return chars.join('');
  return chars.slice(chars.length - limit).join('');
}

function conversationTranscript(conversation = [], characterName = 'Assistant') {
  return (Array.isArray(conversation) ? conversation : [])
    .filter(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        typeof entry.mes === 'string' &&
        entry.mes.trim(),
    )
    .map((entry) => {
      const role = entry.is_system
        ? 'System'
        : entry.is_user
          ? 'User'
          : characterName || 'Assistant';
      return `${role}: ${String(entry.mes).trim()}`;
    })
    .join('\n');
}

export function buildNemoPortableContext({
  character,
  characterName = '',
  conversation = [],
} = {}) {
  const data = asObject(character?.data);
  const resolvedName = String(
    characterName || data.name || character?.name || 'Assistant',
  ).trim() || 'Assistant';
  const transcript = tailByCodePoints(
    conversationTranscript(conversation, resolvedName),
    MAX_TRANSCRIPT_CHARS,
  );
  const shortTerm = tailByCodePoints(transcript, MAX_SHORT_TERM_CHARS);

  return {
    macros: {
      user: 'You',
      char: resolvedName,
      persona: '',
      scenario: String(data.scenario ?? character?.scenario ?? ''),
      group: '',
      personality: String(data.personality ?? character?.personality ?? ''),
      description: String(data.description ?? character?.description ?? ''),
      summary: transcript,
      short_term_memory: shortTerm,
      long_term_memory: '',
      NemoLore: '',
      datetimeformat: '',
    },
    globals: {},
    variables: {},
  };
}

export async function compileNemoInstructions({
  preset,
  context,
  profile = DEFAULT_PROFILE,
  spawnImpl = spawnSync,
} = {}) {
  if (!preset || typeof preset !== 'object' || Array.isArray(preset)) {
    throw new Error('Nemo preset must be a JSON object.');
  }
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new Error('Nemo context must be a JSON object.');
  }
  if (typeof spawnImpl !== 'function') {
    throw new Error('A Nemo runtime spawn implementation is required.');
  }

  const directory = await mkdtemp(path.join(tmpdir(), 'nemo-mobile-'));
  const presetPath = path.join(directory, 'preset.json');
  const contextPath = path.join(directory, 'context.json');

  try {
    await Promise.all([
      writeFile(presetPath, JSON.stringify(preset), 'utf8'),
      writeFile(contextPath, JSON.stringify(context), 'utf8'),
    ]);

    const result = spawnImpl(
      process.execPath,
      [
        RUNTIME_PATH,
        '--preset',
        presetPath,
        '--profile',
        String(profile || DEFAULT_PROFILE),
        '--mode',
        'portable',
        '--context',
        contextPath,
        '--instructions-only',
      ],
      {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
      },
    );

    if (result?.error) throw result.error;
    if (result?.status !== 0) {
      const stderr = String(result?.stderr || '').trim();
      throw new Error(
        `Nemo runtime compilation failed${stderr ? `: ${stderr.slice(0, 1000)}` : '.'}`,
      );
    }

    const instructions = String(result?.stdout || '').trim();
    if (!instructions) {
      throw new Error('Nemo runtime compilation returned empty instructions.');
    }

    return {
      instructions,
      chars: Array.from(instructions).length,
      sha256: createHash('sha256').update(instructions, 'utf8').digest('hex'),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function sanitizeNemoOutput(value) {
  const cleaned = sanitizeOutput(String(value || '')).trim();
  if (!cleaned) {
    throw new Error('Nemo output sanitizer returned empty content.');
  }
  return cleaned;
}
