import { eventSource, event_types, getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { oai_settings, openai_setting_names, openai_settings } from '../../../openai.js';

const ACTIVE_PRESET = 'Nemo Engine 11.5.2 - Ready RU RP';
const BOOTSTRAP_VERSION = '1.1.0';
const STATUS_NS = 'NemoFullBootstrap';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clone = value => typeof structuredClone === 'function'
  ? structuredClone(value)
  : JSON.parse(JSON.stringify(value));

async function waitFor(predicate, timeoutMs = 60000, stepMs = 250) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const value = predicate();
      if (value) return value;
    } catch {
      // keep waiting
    }
    await sleep(stepMs);
  }
  throw new Error('Timed out waiting for NemoPresetExt/SillyTavern runtime.');
}

function getPresetIndex() {
  if (!openai_setting_names || !Object.prototype.hasOwnProperty.call(openai_setting_names, ACTIVE_PRESET)) {
    return null;
  }
  const index = Number(openai_setting_names[ACTIVE_PRESET]);
  return Number.isInteger(index) ? index : null;
}

function enableFullRuntimeFlags() {
  extension_settings.NemoPresetExt ??= {};
  Object.assign(extension_settings.NemoPresetExt, {
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
  saveSettingsDebounced();
}

function updateInMemoryPreset(index, transformed) {
  const current = openai_settings[index] || {};
  for (const key of Object.keys(current)) delete current[key];
  Object.assign(current, clone(transformed));
  openai_settings[index] = current;

  oai_settings.preset_settings_openai = ACTIVE_PRESET;
  saveSettingsDebounced();

  const select = document.querySelector('#settings_preset_openai');
  if (select) {
    select.value = String(index);
    const option = select.querySelector(`option[value="${CSS.escape(String(index))}"]`);
    if (option) option.selected = true;
    const jq = window.jQuery || window.$;
    if (typeof jq === 'function') jq(select).trigger('change');
    else select.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

async function savePreset(transformed) {
  const response = await fetch('/api/presets/save', {
    method: 'POST',
    headers: getRequestHeaders(),
    body: JSON.stringify({
      apiId: 'openai',
      name: ACTIVE_PRESET,
      preset: transformed,
    }),
  });
  if (!response.ok) throw new Error(`Preset save failed (${response.status}).`);
  return response.json().catch(() => ({}));
}

function encodeUtf8Base64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function persistClientReport(report) {
  const name = 'nemo-client-runtime-report.json';
  const payload = JSON.stringify(report, null, 2);
  const response = await fetch('/api/files/upload', {
    method: 'POST',
    headers: getRequestHeaders(),
    body: JSON.stringify({
      name,
      data: encodeUtf8Base64(payload),
    }),
  });
  if (!response.ok) {
    throw new Error(`Client runtime report upload failed (${response.status}).`);
  }
  return { ok: true, path: '/files/' + name };
}

async function runPreflight() {
  const fn = globalThis.nemoRecipeRuntimePreflight;
  if (typeof fn !== 'function') return { available: false, ok: false, aborted: false };
  let aborted = false;
  const result = await fn([], 0, () => { aborted = true; }, 'normal');
  return { available: true, ok: result !== false && !aborted, aborted };
}

function stat(name) {
  try {
    return globalThis[name]?.getStats?.() ?? null;
  } catch (error) {
    return { error: String(error?.message || error) };
  }
}

function publishStatus(report) {
  extension_settings[STATUS_NS] = report;
  saveSettingsDebounced();
  window.NemoFullBootstrapReport = report;

  const summary = report.ok
    ? `Nemo 11.5.2 FULL READY · cold ${report.transform.coldPromptCount} · recipe ${report.transform.recipeRuntime ? 'on' : 'n/a'} · Vex ${report.transform.vexRuntime ? 'on' : 'n/a'}`
    : `Nemo full bootstrap failed: ${report.error || 'unknown error'}`;

  if (report.ok) {
    globalThis.toastr?.success(summary, 'Nemo Full Bootstrap', {
      timeOut: 0,
      extendedTimeOut: 0,
      closeButton: true,
    });
  } else {
    globalThis.toastr?.error(summary, 'Nemo Full Bootstrap', {
      timeOut: 0,
      extendedTimeOut: 0,
      closeButton: true,
    });
  }

  let badge = document.getElementById('nemo-full-bootstrap-status');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'nemo-full-bootstrap-status';
    badge.style.cssText = [
      'position:fixed',
      'right:10px',
      'bottom:10px',
      'z-index:99999',
      'max-width:420px',
      'padding:8px 10px',
      'border-radius:8px',
      'background:rgba(20,20,24,.92)',
      'color:#fff',
      'font:12px/1.35 sans-serif',
      'box-shadow:0 4px 18px rgba(0,0,0,.35)',
    ].join(';');
    document.body.appendChild(badge);
  }
  badge.textContent = summary;
  badge.dataset.ok = report.ok ? 'true' : 'false';
}

async function bootstrap() {
  try {
    await waitFor(() =>
      globalThis.NemoPresetExt &&
      globalThis.NemoRecipeRuntime &&
      globalThis.NemoColdPrompts &&
      globalThis.NemoVexRuntime &&
      globalThis.NemoPromptRendering &&
      getPresetIndex() !== null
    );

    enableFullRuntimeFlags();

    const index = getPresetIndex();
    if (index === null) throw new Error(`Preset "${ACTIVE_PRESET}" is not installed.`);

    const transformed = clone(openai_settings[index]);
    if (!Array.isArray(transformed?.prompts) || !Array.isArray(transformed?.prompt_order)) {
      throw new Error('Active Nemo preset is structurally invalid.');
    }

    await eventSource.emit(event_types.OAI_PRESET_IMPORT_READY, {
      data: transformed,
      presetName: ACTIVE_PRESET,
    });

    await savePreset(transformed);
    updateInMemoryPreset(index, transformed);

    await sleep(2500);
    const preflight = await runPreflight();
    await sleep(1000);

    const transform = {
      recipeRuntime: Boolean(transformed.extensions?.nemoRecipeRuntime),
      vexRuntime: Boolean(transformed.extensions?.nemoVexRuntime),
      coldPromptCount: transformed.prompts.filter(prompt => prompt?.nemoPromptBody).length,
      promptCount: transformed.prompts.length,
      regexCount: Array.isArray(transformed.extensions?.regex_scripts)
        ? transformed.extensions.regex_scripts.length
        : 0,
    };

    const report = {
      ok: preflight.available ? preflight.ok : true,
      bootstrapVersion: BOOTSTRAP_VERSION,
      preset: ACTIVE_PRESET,
      importedAt: new Date().toISOString(),
      transform,
      preflight,
      recipe: stat('NemoRecipeRuntime'),
      cold: stat('NemoColdPrompts'),
      vex: stat('NemoVexRuntime'),
      rendering: stat('NemoPromptRendering'),
    };

    try {
      report.persistence = await persistClientReport(report);
    } catch (error) {
      report.persistence = { ok: false, error: String(error?.message || error) };
    }

    publishStatus(report);
    console.info('[Nemo Full Bootstrap]', report);
  } catch (error) {
    const report = {
      ok: false,
      bootstrapVersion: BOOTSTRAP_VERSION,
      preset: ACTIVE_PRESET,
      importedAt: new Date().toISOString(),
      error: String(error?.message || error),
    };
    try {
      report.persistence = await persistClientReport(report);
    } catch (persistError) {
      report.persistence = { ok: false, error: String(persistError?.message || persistError) };
    }

    publishStatus(report);
    console.error('[Nemo Full Bootstrap]', error);
  }
}

let started = false;
function startOnce() {
  if (started) return;
  started = true;
  void bootstrap();
}

if (event_types.APP_READY) eventSource.on(event_types.APP_READY, startOnce);
setTimeout(startOnce, 1500);
