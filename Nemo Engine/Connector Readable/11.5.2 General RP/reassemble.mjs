#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'manifest.json'), 'utf8'));
const read = (relativePath) => fs.readFileSync(path.join(here, relativePath), 'utf8');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

for (const entry of manifest.generated_files) {
  const content = read(entry.path);
  assert.equal(Buffer.byteLength(content), entry.bytes, `byte count: ${entry.path}`);
  assert.equal(hash(content), entry.sha256, `SHA-256: ${entry.path}`);
}

const settings = JSON.parse(read(manifest.settings.path));
const prompts = manifest.prompt_shards.flatMap((entry) => JSON.parse(read(entry.path)));
const regexScripts = manifest.regex_shards.flatMap((entry) => JSON.parse(read(entry.path)));
const promptOrder = manifest.prompt_order.map((entry) => JSON.parse(read(entry.path)));
const root = {};
for (const key of manifest.top_level_keys) {
  if (key === 'prompts') root[key] = prompts;
  else if (key === 'prompt_order') root[key] = promptOrder;
  else if (key === 'extensions') root[key] = { ...settings.extensions, regex_scripts: regexScripts };
  else root[key] = settings[key];
}

const reconstructed = `${JSON.stringify(root, null, manifest.format.indent)}\n`;
assert.equal(Buffer.byteLength(reconstructed), manifest.source.bytes, 'source byte count');
assert.equal(hash(reconstructed), manifest.source.sha256, 'source SHA-256');

const sourcePath = path.resolve(here, '..', '..', manifest.source.filename);
const source = fs.readFileSync(sourcePath);
assert.ok(source.equals(Buffer.from(reconstructed, 'utf8')), 'byte-for-byte source comparison');

console.log(`Verified ${prompts.length} prompts, ${promptOrder.length} profiles, and ${regexScripts.length} regex scripts.`);
console.log(`Byte-identical SHA-256: ${manifest.source.sha256}`);
