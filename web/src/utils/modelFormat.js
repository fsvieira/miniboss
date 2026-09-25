// Shared formatting/model helpers between UI components.

export function formatTokens(num) {
  if (num == null) return '—';
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
  return String(num);
}

/**
 * Price in USD per 1M tokens.
 * The server normalizes to USD per 1M (number|null).
 */
export function formatPricePer1M(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const num = Number(value);
  if (num < 0) return '—'; // valor desconhecido (-1)
  if (num === 0) return '$0';
  if (num >= 0.01) return '$' + num.toFixed(2);
  return '$' + num.toFixed(4);
}

const EFFORT_LABELS = {
  none: 'None',
  off: 'None',
  false: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
  default: 'Default',
};

export function humanizeEffort(effort) {
  if (!effort) return null;
  const key = String(effort).toLowerCase();
  if (EFFORT_LABELS[key]) return EFFORT_LABELS[key];
  return String(effort).charAt(0).toUpperCase() + String(effort).slice(1);
}

/**
 * Converte um valor de thinking_mode (string simples ou JSON string) num
 * objecto normalizado { enabled?, effort?, maxTokens?, ... }.
 */
export function parseThinkingModeValue(raw) {
  if (raw == null || raw === '' || raw === 'null') return null;
  if (typeof raw === 'object') return raw;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
      return null;
    }
  }
  return { effort: trimmed };
}

/**
 * Readable label of a thinking_mode value for display in chips/tooltips.
 */
export function thinkingModeLabel(raw) {
  const parsed = parseThinkingModeValue(raw);
  if (!parsed) return null;

  if (parsed.enabled === false) return 'None';
  if (parsed.effort) {
    const key = String(parsed.effort).toLowerCase();
    if (key === 'none' || key === 'off' || key === 'false') return 'None';
    return humanizeEffort(parsed.effort) || String(parsed.effort);
  }
  if (parsed.enabled === true) return 'Enabled';
  if (parsed.maxTokens != null) return `Enabled (${formatTokens(parsed.maxTokens)})`;
  return 'Enabled';
}

export function thinkingEquivalent(a, b) {
  if (!a || !b) return false;
  const norm = (x) => x != null ? String(x).toLowerCase() : null;
  const aEffort = norm(a.effort);
  const bEffort = norm(b.effort);
  if (aEffort || bEffort) return aEffort === bEffort;
  return Boolean(a.enabled) === Boolean(b.enabled);
}

/**
 * Returns the `value` of a thinking option that matches the candidate
 * (stored value), or '' (Default) if there is no match.
 */
export function findMatchingThinkingValue(candidate, options) {
  if (!options || options.length === 0) return '';
  if (candidate == null || candidate === '' || candidate === 'null') return '';
  if (options.some((o) => o.value === candidate)) return candidate;
  const candParsed = parseThinkingModeValue(candidate);
  if (!candParsed) return '';
  for (const opt of options) {
    const optParsed = parseThinkingModeValue(opt.value);
    if (optParsed && thinkingEquivalent(candParsed, optParsed)) return opt.value;
  }
  return '';
}

/**
 * Indicates whether the thinking_mode value is effectively "no thinking".
 */
export function isThinkingNone(raw) {
  const parsed = parseThinkingModeValue(raw);
  if (!parsed) return true;
  if (parsed.enabled === false) return true;
  const key = String(parsed.effort || '').toLowerCase();
  return ['none', 'off', 'false', ''].includes(key);
}
