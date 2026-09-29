import { characters, chat, eventSource, event_types, Generate, getRequestHeaders, openCharacterChat, saveSettingsDebounced, selectCharacterById } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { oai_settings, openai_setting_names, openai_settings } from '../../../openai.js';

const GOONER_PRESET = 'Nemo Engine 11.5.2 - Ready RU Gooner RP';
const PSYCHOLOGY_PRESET = 'Nemo Engine 11.5.2 - Ready RU Psychology Humiliation JOI RP';
const SENSORY_PRESET = 'Nemo Engine 11.5.2 - Ready RU Sensory Psychology Humiliation JOI RP';
const LUSTFUL_PRESET = 'Nemo Engine 11.5.2 - Ready RU Lustful Psychology Humiliation JOI RP';
const SUPPORTED_PRESETS = new Set([
  GOONER_PRESET,
  PSYCHOLOGY_PRESET,
  SENSORY_PRESET,
  LUSTFUL_PRESET,
]);
const FALLBACK_PRESET = GOONER_PRESET;
const BOOTSTRAP_VERSION = '1.2.0';

function activePresetName() {
  const selected = String(oai_settings?.preset_settings_openai || '').trim();
  return SUPPORTED_PRESETS.has(selected) ? selected : FALLBACK_PRESET;
}
const STATUS_NS = 'NemoFullBootstrap';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clone = value => typeof structuredClone === 'function'
  ? structuredClone(value)
  : JSON.parse(JSON.stringify(value));

function takeClientGenerationRequest() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('nemoClientGenerate') !== '1') return null;

  const request = {
    avatarUrl: String(params.get('avatarUrl') || '').trim(),
    fileName: String(params.get('fileName') || '').trim(),
    marker: String(params.get('marker') || '').trim(),
    requestId: String(params.get('requestId') || '').trim(),
  };

  const clean = new URL(window.location.href);
  for (const key of ['nemoClientGenerate', 'avatarUrl', 'fileName', 'marker', 'requestId']) {
    clean.searchParams.delete(key);
  }
  history.replaceState({}, document.title, clean.pathname + clean.search + clean.hash);

  return request;
}

const clientGenerationRequest = takeClientGenerationRequest();

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
  if (!openai_setting_names || !Object.prototype.hasOwnProperty.call(openai_setting_names, activePresetName())) {
    return null;
  }
  const index = Number(openai_setting_names[activePresetName()]);
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

  oai_settings.preset_settings_openai = activePresetName();
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
      name: activePresetName(),
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
  const persistence = { ok: true, path: '/files/' + name };
  const persistedReport = { ...report, persistence: persistence };
  const payload = JSON.stringify(persistedReport, null, 2);
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
  return persistence;
}

async function persistClientGenerationReport(report) {
  const name = 'nemo-client-generation-report.json';
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
    throw new Error(`Client generation report upload failed (${response.status}).`);
  }
  return { ok: true, path: '/files/' + name };
}

function publishClientGenerationStatus(report) {
  window.NemoClientGenerationReport = report;

  let badge = document.getElementById('nemo-client-generation-status');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'nemo-client-generation-status';
    badge.style.cssText = [
      'position:fixed',
      'right:10px',
      'bottom:54px',
      'z-index:99999',
      'max-width:460px',
      'padding:8px 10px',
      'border-radius:8px',
      'background:rgba(20,20,24,.92)',
      'color:#fff',
      'font:12px/1.35 sans-serif',
      'box-shadow:0 4px 18px rgba(0,0,0,.35)',
    ].join(';');
    document.body.appendChild(badge);
  }

  badge.dataset.ok = report.ok ? 'true' : 'false';
  badge.dataset.requestId = report.requestId || '';
  badge.textContent = report.ok
    ? `Nemo client generation PASS · ${report.fileName} · messages ${report.beforeCount}→${report.afterCount}`
    : `Nemo client generation failed: ${report.error || 'unknown error'}`;
}

async function runClientGenerationDiagnostic(request, bootstrapReport) {
  if (!request) return null;

  const baseReport = {
    ok: false,
    requestId: request.requestId,
    generatedAt: new Date().toISOString(),
    preset: activePresetName(),
    avatarUrl: request.avatarUrl,
    fileName: request.fileName,
    marker: request.marker,
    beforeCount: 0,
    afterCount: 0,
    assistantMessagePresent: false,
    generatedNewAssistant: false,
    outcome: 'pending',
    bootstrapImportedAt: bootstrapReport?.importedAt || '',
    error: '',
  };

  try {
    if (!request.avatarUrl || !request.fileName || !request.marker || !request.requestId) {
      throw new Error('Client generation request is incomplete.');
    }
    if (!bootstrapReport?.ok) {
      throw new Error('Nemo client bootstrap is not ready.');
    }

    await waitFor(() => Array.isArray(characters) && characters.length > 0, 60000);
    const characterId = characters.findIndex((item) => item?.avatar === request.avatarUrl);
    if (characterId < 0) {
      throw new Error(`Character not found for avatar ${request.avatarUrl}.`);
    }

    await selectCharacterById(characterId);
    await openCharacterChat(request.fileName);
    await waitFor(
      () => chat.some((entry) =>
        entry?.is_user === true &&
        String(entry?.mes || '').trim() === request.marker
      ),
      60000,
    );

    const markerIndex = chat.findIndex((entry) =>
      entry?.is_user === true &&
      String(entry?.mes || '').trim() === request.marker
    );
    if (markerIndex < 0) throw new Error('Control user marker is not present in the selected chat.');

    const existingAssistant = chat
      .slice(markerIndex + 1)
      .find((entry) => entry?.is_user === false && String(entry?.mes || '').trim());
    if (existingAssistant) {
      const report = {
        ...baseReport,
        ok: false,
        beforeCount: chat.length,
        afterCount: chat.length,
        assistantMessagePresent: true,
        generatedNewAssistant: false,
        outcome: 'already_present',
        alreadyGenerated: true,
        error: 'Assistant message already existed after the control marker; no new generation was executed.',
      };
      try {
        report.persistence = await persistClientGenerationReport(report);
      } catch (error) {
        report.persistence = { ok: false, error: String(error?.message || error) };
      }
      publishClientGenerationStatus(report);
      return report;
    }

    const last = chat[chat.length - 1];
    if (
      last?.is_user !== true ||
      String(last?.mes || '').trim() !== request.marker
    ) {
      throw new Error('Control user marker must be the latest chat message.');
    }

    const beforeCount = chat.length;
    await Generate('normal');

    await waitFor(
      () => chat
        .slice(markerIndex + 1)
        .some((entry) => entry?.is_user === false && String(entry?.mes || '').trim()),
      180000,
      250,
    );

    const assistantMessagePresent = chat
      .slice(markerIndex + 1)
      .some((entry) => entry?.is_user === false && String(entry?.mes || '').trim());

    const report = {
      ...baseReport,
      ok: assistantMessagePresent && chat.length > beforeCount,
      generatedAt: new Date().toISOString(),
      beforeCount,
      afterCount: chat.length,
      assistantMessagePresent,
      generatedNewAssistant: assistantMessagePresent && chat.length > beforeCount,
      outcome: assistantMessagePresent && chat.length > beforeCount ? 'generated' : 'no_new_assistant',
    };
    if (!report.ok) {
      report.error = 'Generate completed without a persisted assistant message.';
    }

    try {
      report.persistence = await persistClientGenerationReport(report);
    } catch (error) {
      report.persistence = { ok: false, error: String(error?.message || error) };
    }
    publishClientGenerationStatus(report);
    return report;
  } catch (error) {
    const report = {
      ...baseReport,
      generatedAt: new Date().toISOString(),
      beforeCount: Array.isArray(chat) ? chat.length : 0,
      afterCount: Array.isArray(chat) ? chat.length : 0,
      generatedNewAssistant: false,
      outcome: 'error',
      error: String(error?.message || error),
    };
    try {
      report.persistence = await persistClientGenerationReport(report);
    } catch (persistError) {
      report.persistence = { ok: false, error: String(persistError?.message || persistError) };
    }
    publishClientGenerationStatus(report);
    return report;
  }
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
    if (index === null) throw new Error(`Preset "${activePresetName()}" is not installed.`);

    const transformed = clone(openai_settings[index]);
    if (!Array.isArray(transformed?.prompts) || !Array.isArray(transformed?.prompt_order)) {
      throw new Error('Active Nemo preset is structurally invalid.');
    }

    await eventSource.emit(event_types.OAI_PRESET_IMPORT_READY, {
      data: transformed,
      presetName: activePresetName(),
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
      preset: activePresetName(),
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
    await runClientGenerationDiagnostic(clientGenerationRequest, report);
    console.info('[Nemo Full Bootstrap]', report);
  } catch (error) {
    const report = {
      ok: false,
      bootstrapVersion: BOOTSTRAP_VERSION,
      preset: activePresetName(),
      importedAt: new Date().toISOString(),
      error: String(error?.message || error),
    };
    try {
      report.persistence = await persistClientReport(report);
    } catch (persistError) {
      report.persistence = { ok: false, error: String(persistError?.message || persistError) };
    }

    publishStatus(report);
    await runClientGenerationDiagnostic(clientGenerationRequest, report);
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
