'use strict';

// install-state.js — v0158c — pure function computing "installation status" of
// the user's chosen LLM. Reframes settings.json {provider, model, apiKey} as
// "is Claude installed in Hypha?" status rather than "is the API configured?".
//
// Per user 2026-05-04 reframe: Hypha = local LLM runtime. Once an LLM is
// "installed" (= apiKey set + provider chosen), all features (Spotlight,
// LessonChat, DeepenCallout) use that installation = 统一性. This module is
// the read side of that semantic shift.

const PROVIDERS = require('./providers').PROVIDERS;

const STALE_DAYS_THRESHOLD = 7;     // verified within 7 days = green; older = yellow

function _findProvider(providerId) {
  return PROVIDERS.find(p => p.id === providerId) || null;
}

function _findModel(provider, modelId) {
  if (!provider || !provider.models) return null;
  return provider.models.find(m => m.id === modelId) || null;
}

// Compute installation state from settings.json contents.
// Returns: { installed, providerLabel, modelLabel, lastVerifiedAt, staleDays, statusColor, statusText }
function getInstallState(settings) {
  const s = settings || {};
  const provider = _findProvider(s.provider);
  const model = provider ? _findModel(provider, s.model) : null;

  const providerLabel = provider ? provider.label : (s.provider || 'unknown');
  const modelLabel = model ? model.label : (s.model || 'default');

  const installed = !!(s.apiKey && s.apiKey.trim());

  if (!installed) {
    return {
      installed: false,
      providerLabel,
      modelLabel,
      lastVerifiedAt: null,
      staleDays: null,
      statusColor: 'gray',
      statusText: 'not installed',
    };
  }

  const lastVerifiedAt = s._lastVerifiedAt || null;
  let staleDays = null;
  let statusColor = 'yellow';
  let statusText = 'installed but not verified yet';

  if (lastVerifiedAt) {
    const ms = Date.now() - new Date(lastVerifiedAt).getTime();
    staleDays = Math.floor(ms / (1000 * 60 * 60 * 24));
    if (staleDays <= STALE_DAYS_THRESHOLD) {
      statusColor = 'green';
      // human-friendly time-ago
      const min = Math.floor(ms / 60000);
      let ago;
      if (min < 1) ago = 'just now';
      else if (min < 60) ago = min + ' min ago';
      else if (min < 60 * 24) ago = Math.floor(min / 60) + ' hours ago';
      else ago = staleDays + ' day' + (staleDays === 1 ? '' : 's') + ' ago';
      statusText = `last verified ${ago}`;
    } else {
      statusText = `last verified ${staleDays} days ago — re-test recommended`;
    }
  }

  return {
    installed: true,
    providerLabel,
    modelLabel,
    lastVerifiedAt,
    staleDays,
    statusColor,
    statusText,
  };
}

module.exports = { getInstallState, STALE_DAYS_THRESHOLD };
