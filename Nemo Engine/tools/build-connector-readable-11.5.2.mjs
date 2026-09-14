#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineRoot = path.resolve(here, '..');
const sourcePath = path.join(engineRoot, 'Nemo Engine 11.5.2 - General RP.json');
const outputRoot = path.join(engineRoot, 'Connector Readable', '11.5.2 General RP');
const fileLimit = 49_152;
const sourceCommit = '6de820a723a5d68d5d3a288fdfd14a43c4951d1a';
const sourceBlob = '34a469106a1df6fa88a77e3ae0673d0271e21fee';

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function gitBlobOid(data) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  return crypto
    .createHash('sha1')
    .update(Buffer.from(`blob ${body.length}\0`, 'utf8'))
    .update(body)
    .digest('hex');
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function bytes(value) {
  return Buffer.byteLength(value, 'utf8');
}

function pad(value, width = 3) {
  return String(value).padStart(width, '0');
}

function splitArray(items, directory, prefix) {
  const shards = [];
  let start = 0;

  while (start < items.length) {
    let end = start;
    let accepted = null;

    while (end < items.length) {
      const candidate = json(items.slice(start, end + 1));
      if (bytes(candidate) > fileLimit) {
        if (end === start) {
          throw new Error(`${prefix}[${start}] exceeds ${fileLimit} bytes`);
        }
        break;
      }
      accepted = candidate;
      end += 1;
    }

    const last = end - 1;
    const relativePath = `${directory}/${prefix}-${pad(start)}-${pad(last)}.json`;
    shards.push({
      path: relativePath,
      start,
      end: last,
      count: last - start + 1,
      content: accepted,
      bytes: bytes(accepted),
      sha256: sha256(accepted),
    });
    start = end;
  }

  return shards;
}

function buildFiles(sourceRaw, source) {
  const files = new Map();
  const add = (relativePath, content) => {
    assert.ok(!files.has(relativePath), `duplicate output: ${relativePath}`);
    assert.ok(bytes(content) <= fileLimit, `${relativePath} exceeds ${fileLimit} bytes`);
    files.set(relativePath, content);
  };

  const settings = {};
  for (const key of Object.keys(source)) {
    if (key === 'prompts' || key === 'prompt_order') continue;
    if (key === 'extensions') {
      settings.extensions = {};
      for (const extensionKey of Object.keys(source.extensions)) {
        if (extensionKey !== 'regex_scripts') {
          settings.extensions[extensionKey] = source.extensions[extensionKey];
        }
      }
      continue;
    }
    settings[key] = source[key];
  }

  const settingsContent = json(settings);
  add('settings.json', settingsContent);

  const promptShards = splitArray(source.prompts, 'prompts', 'prompts');
  for (const shard of promptShards) add(shard.path, shard.content);

  const regexScripts = source.extensions.regex_scripts;
  const regexShards = splitArray(regexScripts, 'regex-scripts', 'regex');
  for (const shard of regexShards) add(shard.path, shard.content);

  const orderFiles = source.prompt_order.map((profile, index) => {
    const relativePath = `prompt-order/${profile.character_id}.json`;
    const content = json(profile);
    add(relativePath, content);
    return {
      path: relativePath,
      index,
      character_id: profile.character_id,
      entries: profile.order.length,
      enabled: profile.order.filter((entry) => entry.enabled).length,
      disabled: profile.order.filter((entry) => !entry.enabled).length,
      bytes: bytes(content),
      sha256: sha256(content),
    };
  });

  const shardForIndex = (index) =>
    promptShards.find((shard) => index >= shard.start && index <= shard.end).path;

  const promptIndex = source.prompts
    .map((prompt, index) =>
      JSON.stringify({
        index,
        identifier: prompt.identifier,
        name: prompt.name,
        role: prompt.role,
      }),
    )
    .join('\n') + '\n';
  add('prompt-index.jsonl', promptIndex);

  const regexIndex = regexScripts
    .map((script, index) =>
      JSON.stringify({
        index,
        id: script.id,
        name: script.scriptName,
        disabled: script.disabled,
      }),
    )
    .join('\n') + '\n';
  add('regex-index.jsonl', regexIndex);

  const activeIndexes = {};
  for (const profile of source.prompt_order) {
    const byIdentifier = new Map(source.prompts.map((prompt, index) => [prompt.identifier, index]));
    const active = profile.order
      .map((entry, orderIndex) => ({ entry, orderIndex }))
      .filter(({ entry }) => entry.enabled)
      .map(({ entry, orderIndex }) => {
        const promptIndexValue = byIdentifier.get(entry.identifier);
        const prompt = source.prompts[promptIndexValue];
        return {
          order_index: orderIndex,
          prompt_index: promptIndexValue,
          identifier: entry.identifier,
          name: prompt.name,
          role: prompt.role,
          shard: shardForIndex(promptIndexValue),
        };
      });
    const relativePath = `active-stack/${profile.character_id}.json`;
    const content = json(active);
    add(relativePath, content);
    activeIndexes[profile.character_id] = {
      path: relativePath,
      count: active.length,
      bytes: bytes(content),
      sha256: sha256(content),
    };
  }

  const readme = `# Nemo Engine 11.5.2 — connector-readable mirror

This directory is an additive, lossless view of \`../../Nemo Engine 11.5.2 - General RP.json\`. The original importable preset is unchanged.

The source is not minified. Its size exceeds the GitHub Contents response that many chat clients render conveniently, so it is split into valid UTF-8 JSON files of at most 48 KiB. \`reassemble.mjs\` recreates the original file byte for byte.

## GitHub connector route

1. Read \`manifest.json\`.
2. Read \`prompt-index.jsonl\` to locate any prompt, or every file listed under \`prompt_shards\` to inspect all ${source.prompts.length} prompts.
3. Read \`prompt-order/100001.json\` for the normal ChatGPT/SillyTavern runtime profile. Activation comes from each order entry's \`enabled\` value, not from \`prompts[].enabled\`.
4. Read \`active-stack/100001.json\` for a compact ordered map of the ${activeIndexes[100001]?.count ?? 0} active prompts and their shards.
5. Read every file under \`regex_shards\` to inspect all ${regexScripts.length} regex scripts (${regexScripts.filter((entry) => !entry.disabled).length} active).
6. Read \`settings.json\` for the remaining top-level preset settings.

If code-mode access is available, the connector can also call \`github_fetch_blob\` with blob \`${sourceBlob}\`, then parse \`result.content\` inside the tool call without printing the entire 1.7 MB payload. Do not fall back to 11.3 merely because a direct rendered response is truncated.

## Integrity

- Source commit: \`${sourceCommit}\`
- Git blob: \`${sourceBlob}\`
- Source bytes: \`${Buffer.byteLength(sourceRaw)}\`
- Source SHA-256: \`${sha256(sourceRaw)}\`
- Prompts: \`${source.prompts.length}\`
- Prompt-order profiles: \`${source.prompt_order.length}\`
- Regex scripts: \`${regexScripts.length}\`

Run \`node reassemble.mjs\` from this directory to verify every shard and compare the reconstructed bytes with the original preset.
`;
  add('README.md', readme);

  const reassemble = `#!/usr/bin/env node
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
  assert.equal(Buffer.byteLength(content), entry.bytes, \`byte count: \${entry.path}\`);
  assert.equal(hash(content), entry.sha256, \`SHA-256: \${entry.path}\`);
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

const reconstructed = \`\${JSON.stringify(root, null, manifest.format.indent)}\\n\`;
assert.equal(Buffer.byteLength(reconstructed), manifest.source.bytes, 'source byte count');
assert.equal(hash(reconstructed), manifest.source.sha256, 'source SHA-256');

const sourcePath = path.resolve(here, '..', '..', manifest.source.filename);
const source = fs.readFileSync(sourcePath);
assert.ok(source.equals(Buffer.from(reconstructed, 'utf8')), 'byte-for-byte source comparison');

console.log(\`Verified \${prompts.length} prompts, \${promptOrder.length} profiles, and \${regexScripts.length} regex scripts.\`);
console.log(\`Byte-identical SHA-256: \${manifest.source.sha256}\`);
`;
  add('reassemble.mjs', reassemble);

  const fileMetadata = [...files.entries()]
    .map(([relativePath, content]) => ({
      path: relativePath,
      bytes: bytes(content),
      sha256: sha256(content),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const manifest = {
    schema_version: 1,
    purpose: 'Connector-readable, byte-reconstructable mirror; original preset remains authoritative',
    source: {
      repository: 'producesplatinum-ai/NemoEngine',
      commit: sourceCommit,
      filename: path.basename(sourcePath),
      path: 'Nemo Engine/Nemo Engine 11.5.2 - General RP.json',
      git_blob_sha1: sourceBlob,
      bytes: Buffer.byteLength(sourceRaw),
      characters: sourceRaw.length,
      lines: sourceRaw.split('\n').length,
      encoding: 'UTF-8',
      bom: false,
      line_ending: 'LF',
      final_newline: sourceRaw.endsWith('\n'),
      sha256: sha256(sourceRaw),
    },
    format: {
      indent: 2,
      max_connector_file_bytes: fileLimit,
      array_order_preserved: true,
      object_key_order_preserved: true,
    },
    counts: {
      top_level_keys: Object.keys(source).length,
      prompts: source.prompts.length,
      prompt_order_profiles: source.prompt_order.length,
      prompt_order_entries_per_profile: source.prompt_order.map((profile) => profile.order.length),
      regex_scripts: regexScripts.length,
      active_regex_scripts: regexScripts.filter((entry) => !entry.disabled).length,
    },
    top_level_keys: Object.keys(source),
    settings: {
      path: 'settings.json',
      bytes: bytes(settingsContent),
      sha256: sha256(settingsContent),
    },
    prompt_index: 'prompt-index.jsonl',
    regex_index: 'regex-index.jsonl',
    active_stacks: activeIndexes,
    prompt_shards: promptShards.map(({ content, ...entry }) => entry),
    prompt_order: orderFiles,
    regex_shards: regexShards.map(({ content, ...entry }) => entry),
    generated_files: fileMetadata,
  };

  files.set('manifest.json', json(manifest));
  return files;
}

function validateSource(sourceRaw, source) {
  assert.equal(sourceRaw.charCodeAt(0), 0x7b, 'source must not have a BOM');
  assert.ok(sourceRaw.endsWith('\n'), 'source must have a final LF');
  assert.ok(!sourceRaw.includes('\r'), 'source must use LF only');
  assert.equal(`${JSON.stringify(source, null, 2)}\n`, sourceRaw, 'source must be canonical 2-space JSON');
  assert.equal(source.prompts.length, 458, 'prompt count');
  assert.equal(source.prompt_order.length, 2, 'profile count');
  assert.deepEqual(source.prompt_order.map((profile) => profile.order.length), [458, 458]);
  assert.equal(source.extensions.regex_scripts.length, 97, 'regex count');
  assert.equal(sha256(sourceRaw), 'c5e13e951340d17addef0e16e7a7152a8256c41f2c046a52e81d86e1feef31d4');
  assert.equal(gitBlobOid(sourceRaw), sourceBlob);

  const ids = source.prompts.map((prompt) => prompt.identifier);
  assert.equal(new Set(ids).size, ids.length, 'prompt identifiers must be unique');
  const idSet = new Set(ids);
  for (const profile of source.prompt_order) {
    assert.equal(new Set(profile.order.map((entry) => entry.identifier)).size, ids.length);
    assert.ok(profile.order.every((entry) => idSet.has(entry.identifier)));
  }
}

function verifyOutput(expectedFiles, root = outputRoot) {
  const actualFiles = [];
  const walk = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(directory, entry.name), relativePath);
      else actualFiles.push(relativePath);
    }
  };
  walk(root);
  actualFiles.sort();
  assert.deepEqual(actualFiles, [...expectedFiles.keys()].sort(), 'generated file set');

  for (const [relativePath, expected] of expectedFiles) {
    const actual = fs.readFileSync(path.join(root, relativePath), 'utf8');
    assert.equal(actual, expected, relativePath);
    assert.ok(Buffer.byteLength(actual) <= fileLimit, `${relativePath} exceeds connector limit`);
  }

  const result = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');
  assert.ok(result.length > 0);
}

function writeOutput(root, expectedFiles) {
  for (const [relativePath, content] of expectedFiles) {
    const destination = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content, 'utf8');
  }
}

function replaceOutputAtomically(expectedFiles) {
  fs.mkdirSync(path.dirname(outputRoot), { recursive: true });
  const stagingRoot = fs.mkdtempSync(
    path.join(path.dirname(outputRoot), `${path.basename(outputRoot)}.staging-`),
  );
  const backupRoot = `${stagingRoot}.previous`;
  let movedExistingOutput = false;

  try {
    writeOutput(stagingRoot, expectedFiles);
    verifyOutput(expectedFiles, stagingRoot);

    if (fs.existsSync(outputRoot)) {
      const status = fs.lstatSync(outputRoot);
      assert.ok(
        status.isDirectory() && !status.isSymbolicLink(),
        `refusing to replace non-directory or symbolic-link output: ${outputRoot}`,
      );
      fs.renameSync(outputRoot, backupRoot);
      movedExistingOutput = true;
    }

    try {
      fs.renameSync(stagingRoot, outputRoot);
    } catch (error) {
      if (movedExistingOutput) fs.renameSync(backupRoot, outputRoot);
      throw error;
    }

    if (movedExistingOutput) {
      fs.rmSync(backupRoot, { recursive: true, force: true });
    }
  } catch (error) {
    if (fs.existsSync(stagingRoot)) {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
    if (
      movedExistingOutput &&
      fs.existsSync(backupRoot) &&
      !fs.existsSync(outputRoot)
    ) {
      fs.renameSync(backupRoot, outputRoot);
    }
    throw error;
  }
}

const sourceRaw = fs.readFileSync(sourcePath, 'utf8');
const source = JSON.parse(sourceRaw);
validateSource(sourceRaw, source);
const expectedFiles = buildFiles(sourceRaw, source);
const command = process.argv[2] ?? '--check';

if (command === '--write') {
  replaceOutputAtomically(expectedFiles);
} else if (command !== '--check') {
  throw new Error('Usage: build-connector-readable-11.5.2.mjs [--write|--check]');
}

verifyOutput(expectedFiles);
console.log(`Verified ${expectedFiles.size} connector-readable files at ${outputRoot}`);
