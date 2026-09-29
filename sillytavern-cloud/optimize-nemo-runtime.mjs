import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const userDataDir = process.env.SILLYTAVERN_USER_DATA_DIR || '/persistent/data/default-user';
const extensionDir = process.env.NEMO_PRESET_EXT_DIR || path.join(userDataDir, 'extensions', 'NemoPresetExt');
const activePreset = process.env.NEMO_ACTIVE_PRESET || 'Nemo Engine 11.5.2 - Ready RU RP';

const presetPath = path.join(userDataDir, 'OpenAI Settings', activePreset + '.json');
const settingsPath = path.join(userDataDir, 'settings.json');
const filesDir = path.join(userDataDir, 'user', 'files');
const backupDir = path.join(userDataDir, 'backups', 'nemo-runtime');
const backupPath = path.join(backupDir, activePreset + '.portable.json');
const reportPath = path.join(filesDir, 'nemo-runtime-report.json');

function atomicWrite(filePath, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = filePath + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, text, { mode });
  fs.renameSync(temp, filePath);
  try { fs.chmodSync(filePath, mode); } catch {}
}

function safeSidecarName(name) {
  if (typeof name !== 'string' || !/^nemo-[A-Za-z0-9._-]+\.json$/.test(name) || name.includes('..')) {
    throw new Error('Unsafe Nemo sidecar name.');
  }
  return name;
}

function fileResponse(filePath) {
  if (!fs.existsSync(filePath)) return new Response('Not found', { status: 404 });
  const body = fs.readFileSync(filePath);
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-length': String(body.byteLength),
    },
  });
}

function createLocalFetch() {
  return async function localFetch(input, options = {}) {
    const target = String(input);

    if (target.startsWith('/files/')) {
      const name = safeSidecarName(target.slice('/files/'.length));
      return fileResponse(path.join(filesDir, name));
    }

    if (target === '/api/files/upload' && String(options.method || 'GET').toUpperCase() === 'POST') {
      const payload = JSON.parse(String(options.body || '{}'));
      const name = safeSidecarName(payload.name);
      if (typeof payload.data !== 'string') return new Response('Bad request', { status: 400 });
      const bytes = Buffer.from(payload.data, 'base64');
      const targetPath = path.join(filesDir, name);
      fs.mkdirSync(filesDir, { recursive: true });

      if (!fs.existsSync(targetPath) || !fs.readFileSync(targetPath).equals(bytes)) {
        atomicWrite(targetPath, bytes);
      }

      return new Response(JSON.stringify({ path: '/files/' + name }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  };
}

function ensureEsmBoundary() {
  const packagePath = path.join(extensionDir, 'package.json');
  if (!fs.existsSync(packagePath)) {
    atomicWrite(packagePath, JSON.stringify({ type: 'module' }, null, 2) + '\n');
    return;
  }

  const current = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (current.type !== 'module') {
    atomicWrite(packagePath, JSON.stringify({ ...current, type: 'module' }, null, 2) + '\n');
  }
}

async function load(rel) {
  const fullPath = path.join(extensionDir, rel);
  if (!fs.existsSync(fullPath)) throw new Error('Missing NemoPresetExt module: ' + rel);
  return import(pathToFileURL(fullPath).href + '?offline=' + Date.now());
}

function countSidecars(prefix) {
  if (!fs.existsSync(filesDir)) return 0;
  return fs.readdirSync(filesDir).filter(name => name.startsWith(prefix) && name.endsWith('.json')).length;
}

function updateSettings(report) {
  const original = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const beforeProvider = {
    chatCompletionSource: original?.oai_settings?.chat_completion_source ?? null,
    groqModel: original?.oai_settings?.groq_model ?? null,
    deepseekModel: original?.oai_settings?.deepseek_model ?? null,
    openrouterModel: original?.oai_settings?.openrouter_model ?? null,
    selectedProfile: original?.extension_settings?.connectionManager?.selectedProfile ?? null,
  };

  original.oai_settings ??= {};
  original.oai_settings.preset_settings_openai = activePreset;

  original.extension_settings ??= {};
  original.extension_settings.NemoPresetExt ??= {};
  Object.assign(original.extension_settings.NemoPresetExt, {
    enablePromptManager: true,
    enablePresetNavigator: true,
    enableCharacterNavigator: true,
    enableReasoningCapture: true,
    enableReasoningSection: true,
    enableDirectives: true,
    enableDirectiveAutocomplete: true,
    enableNemoEngineInstaller: true,
    enableRecipeRuntime: true,
    enableColdPromptStorage: true,
    enableVexRuntime: true,
    enableIncrementalPromptRendering: true,
  });
  original.extension_settings.NemoFullRuntime = report;

  const afterProvider = {
    chatCompletionSource: original?.oai_settings?.chat_completion_source ?? null,
    groqModel: original?.oai_settings?.groq_model ?? null,
    deepseekModel: original?.oai_settings?.deepseek_model ?? null,
    openrouterModel: original?.oai_settings?.openrouter_model ?? null,
    selectedProfile: original?.extension_settings?.connectionManager?.selectedProfile ?? null,
  };

  if (JSON.stringify(beforeProvider) !== JSON.stringify(afterProvider)) {
    throw new Error('Provider/profile selection changed during Nemo optimization.');
  }

  atomicWrite(settingsPath, JSON.stringify(original, null, 4) + '\n');
}

async function main() {
  if (!fs.existsSync(presetPath)) throw new Error('Nemo preset not found: ' + presetPath);
  if (!fs.existsSync(settingsPath)) throw new Error('SillyTavern settings not found.');
  if (!fs.existsSync(path.join(extensionDir, 'manifest.json'))) throw new Error('NemoPresetExt is not installed.');

  fs.mkdirSync(filesDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  const rawText = fs.readFileSync(presetPath, 'utf8');
  if (!fs.existsSync(backupPath)) atomicWrite(backupPath, rawText);

  let preset = JSON.parse(rawText);
  ensureEsmBoundary();

  const [
    recipeFormat,
    recipeStoreModule,
    vexFormat,
    vexStoreModule,
    coldFormat,
    coldStoreModule,
  ] = await Promise.all([
    load('features/recipe-runtime/format.js'),
    load('features/recipe-runtime/store.js'),
    load('features/vex-runtime/format.js'),
    load('features/vex-runtime/store.js'),
    load('features/cold-prompts/format.js'),
    load('features/cold-prompts/store.js'),
  ]);

  const localFetch = createLocalFetch();

  const recipe = {
    applicable: Boolean(recipeFormat.runtimeOf(preset) || recipeFormat.isCandidate(preset)),
    active: false,
    validated: false,
  };
  {
    const store = new recipeStoreModule.RecipeStore({ fetchFn: localFetch, headers: () => ({}) });
    if (recipeFormat.runtimeOf(preset)) {
      await store.manifest(preset);
      recipe.active = true;
      recipe.validated = true;
    } else if (recipeFormat.isCandidate(preset)) {
      const plan = recipeFormat.planExtraction(preset);
      preset = await store.extract(preset, plan);
      await store.manifest(preset);
      recipe.active = true;
      recipe.validated = true;
    }
  }

  const vex = {
    applicable: Boolean(vexFormat.runtimeOf(preset) || vexFormat.candidate(preset)),
    active: false,
    validated: false,
  };
  {
    const store = new vexStoreModule.VexStore({ fetchFn: localFetch, headers: () => ({}) });
    if (vexFormat.runtimeOf(preset)) {
      await store.manifest(preset);
      vex.active = true;
      vex.validated = true;
    } else if (vexFormat.candidate(preset)) {
      const plan = await vexFormat.planExtraction(preset, async prompt => prompt?.content ?? '');
      preset = await store.extract(preset, plan);
      await store.manifest(preset);
      vex.active = true;
      vex.validated = true;
    }
  }

  coldFormat.validatePreset(preset);
  const cold = {
    applicable: Boolean(coldFormat.hasBodies(preset) || coldFormat.isNemoPreset(preset)),
    active: false,
    validated: false,
    count: 0,
  };
  {
    const store = new coldStoreModule.PromptBodyStore({ fetchFn: localFetch, headers: () => ({}) });
    if (coldFormat.hasBodies(preset)) {
      const refs = preset.prompts.filter(prompt => coldFormat.descriptorOf(prompt));
      await store.readMany(refs, () => {});
      cold.count = refs.length;
      cold.active = refs.length > 0;
      cold.validated = true;
    } else if (coldFormat.isNemoPreset(preset)) {
      const records = preset.prompts
        .filter(coldFormat.eligible)
        .map(prompt => ({ prompt, content: prompt.content }));

      if (records.length) {
        const descriptors = await store.writeMany(records);
        preset = {
          ...preset,
          prompts: preset.prompts.map(prompt => descriptors.has(prompt)
            ? {
                ...prompt,
                [coldFormat.BODY_KEY]: descriptors.get(prompt),
                content: descriptors.get(prompt).shell,
              }
            : prompt),
        };

        const refs = preset.prompts.filter(prompt => coldFormat.descriptorOf(prompt));
        await store.readMany(refs, () => {});
        cold.count = refs.length;
        cold.active = refs.length > 0;
        cold.validated = true;
      } else {
        cold.validated = true;
      }
    }
  }

  coldFormat.validatePreset(preset);

  const report = {
    ok:
      (!recipe.applicable || (recipe.active && recipe.validated)) &&
      (!vex.applicable || (vex.active && vex.validated)) &&
      (!cold.applicable || cold.validated),
    preset: activePreset,
    optimizedAt: new Date().toISOString(),
    promptCount: Array.isArray(preset.prompts) ? preset.prompts.length : 0,
    regexCount: Array.isArray(preset.extensions?.regex_scripts) ? preset.extensions.regex_scripts.length : 0,
    recipe,
    vex,
    cold,
    sidecars: {
      recipe: countSidecars('nemo-recipes-'),
      vex: countSidecars('nemo-vex-source-'),
      cold: countSidecars('nemo-prompts-'),
    },
    rendering: {
      stage: '5B.3/5',
      enabled: true,
      clientRuntime: 'NemoPresetExt',
    },
  };

  if (!report.ok) throw new Error('Nemo runtime optimization did not satisfy every applicable stage.');

  atomicWrite(presetPath, JSON.stringify(preset, null, 4) + '\n');
  atomicWrite(reportPath, JSON.stringify(report, null, 2) + '\n');
  updateSettings(report);

  console.log(
    'Nemo runtime optimized: ' +
    'recipe=' + (recipe.applicable ? (recipe.active ? 'active' : 'failed') : 'n/a') +
    ', vex=' + (vex.applicable ? (vex.active ? 'active' : 'failed') : 'n/a') +
    ', cold=' + cold.count +
    ', rendering=enabled',
  );
  console.log('Nemo runtime report: ' + reportPath);
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
