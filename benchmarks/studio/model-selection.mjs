export function selectModelConfiguration(configured = {}, options = {}) {
  const explicitModel = options.model ? String(options.model) : null;
  if (explicitModel && !options.provider) {
    throw new Error('--provider is required when --model overrides the configured model');
  }

  const selected = {
    model: explicitModel || configured.model,
    model_reasoning_effort: options.reasoning || (explicitModel ? null : configured.model_reasoning_effort || null),
    model_provider: options.provider || (explicitModel ? null : configured.model_provider || 'openai-default'),
  };
  if (!selected.model) throw new Error('An explicitly selected real Codex model is required');
  return selected;
}

export function parseTrialFeedback(raw) {
  const text = raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i, '$1');
  try {
    const value = JSON.parse(text);
    if (typeof value?.claimCompleted !== 'boolean' || !Number.isFinite(value.easeScore) || value.easeScore < 0 || value.easeScore > 10 ||
        typeof value.scoreReason !== 'string' || !Array.isArray(value.frictions) || !value.frictions.every(item => typeof item === 'string') || typeof value.summary !== 'string') return null;
    return value;
  } catch { return null; }
}
