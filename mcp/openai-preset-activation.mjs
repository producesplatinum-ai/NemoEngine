const PRESET_KEYS = new Set([
  'chat_completion_source',
  'temperature',
  'frequency_penalty',
  'presence_penalty',
  'top_p',
  'top_k',
  'top_a',
  'min_p',
  'repetition_penalty',
  'max_context_unlocked',
  'group_models',
  'sort_models',
  'openai_model',
  'claude_model',
  'openrouter_model',
  'openrouter_use_fallback',
  'openrouter_providers',
  'openrouter_quantizations',
  'openrouter_allow_fallbacks',
  'openrouter_middleout',
  'tool_reasoning_mode',
  'ai21_model',
  'mistralai_model',
  'cohere_model',
  'perplexity_model',
  'groq_model',
  'chutes_model',
  'siliconflow_model',
  'siliconflow_endpoint',
  'minimax_model',
  'minimax_endpoint',
  'electronhub_model',
  'nanogpt_model',
  'nanogpt_provider',
  'nanogpt_payg_override',
  'deepseek_model',
  'aimlapi_model',
  'xai_model',
  'pollinations_model',
  'pollinations_endpoint',
  'moonshot_model',
  'fireworks_model',
  'cometapi_model',
  'custom_model',
  'custom_url',
  'custom_include_body',
  'custom_exclude_body',
  'custom_include_headers',
  'custom_prompt_post_processing',
  'google_model',
  'vertexai_model',
  'zai_model',
  'zai_endpoint',
  'workers_ai_model',
  'workers_ai_account_id',
  'openai_max_context',
  'openai_max_tokens',
  'names_behavior',
  'send_if_empty',
  'impersonation_prompt',
  'new_chat_prompt',
  'new_group_chat_prompt',
  'new_example_chat_prompt',
  'continue_nudge_prompt',
  'bias_preset_selected',
  'reverse_proxy',
  'wi_format',
  'scenario_format',
  'personality_format',
  'group_nudge_prompt',
  'stream_openai',
  'prompts',
  'prompt_order',
  'show_external_models',
  'proxy_password',
  'assistant_prefill',
  'assistant_impersonation',
  'use_sysprompt',
  'vertexai_auth_mode',
  'vertexai_region',
  'vertexai_express_project_id',
  'squash_system_messages',
  'media_inlining',
  'inline_image_quality',
  'continue_prefill',
  'continue_postfix',
  'function_calling',
  'tool_call_recurse_limit',
  'show_thoughts',
  'reasoning_effort',
  'verbosity',
  'enable_web_search',
  'seed',
  'n',
  'bypass_status_check',
  'request_images',
  'request_image_aspect_ratio',
  'request_image_resolution',
  'azure_base_url',
  'azure_deployment_name',
  'azure_api_version',
  'azure_openai_model',
  'extensions',
]);

const SETTINGS_KEY_ALIASES = Object.freeze({
  temperature: 'temp_openai',
  frequency_penalty: 'freq_pen_openai',
  presence_penalty: 'pres_pen_openai',
  top_p: 'top_p_openai',
  top_k: 'top_k_openai',
  top_a: 'top_a_openai',
  min_p: 'min_p_openai',
  repetition_penalty: 'repetition_penalty_openai',
});

const clone = (value) => JSON.parse(JSON.stringify(value));

export function applyOpenAiPresetToSettings(settings, preset, presetName) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('settings must be an object.');
  }
  if (!preset || typeof preset !== 'object' || Array.isArray(preset)) {
    throw new Error('preset must be an object.');
  }
  const name = String(presetName || '').trim();
  if (!name) throw new Error('presetName is required.');

  const next = clone(settings);
  if (!next.oai_settings || typeof next.oai_settings !== 'object' || Array.isArray(next.oai_settings)) {
    next.oai_settings = {};
  }

  for (const key of PRESET_KEYS) {
    if (!Object.hasOwn(preset, key)) continue;
    const settingsKey = SETTINGS_KEY_ALIASES[key] || key;
    next.oai_settings[settingsKey] = clone(preset[key]);
  }

  next.oai_settings.preset_settings_openai = name;
  return next;
}
