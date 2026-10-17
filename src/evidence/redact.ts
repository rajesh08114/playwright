const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(authorization\s*[:=]\s*(?:bearer|basic|token)\s+)[^\s,;"']+/gi, "$1[REDACTED]"],
  [/((?:set-)?cookie\s*[:=]\s*)[^\s;"']+/gi, "$1[REDACTED]"],
  [/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret|password|passwd|pwd|session[_-]?id|auth|token)\s*[:=]\s*["']?)[^\s,;&"']+/gi, "$1[REDACTED]"],
  [/("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|secret|password|token)"\s*:\s*")[^"]*/gi, "$1[REDACTED]"],
  [/([?&](?:token|access_token|api_key|apikey|key|sig|signature|code|password|secret)=)[^&#\s"']+/gi, "$1[REDACTED]"],
  [/\b(?:sk|pk|rk)_(?:live|test)?_?[A-Za-z0-9_-]{12,}/g, "[REDACTED]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED_JWT]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED]"]
];

export function redactSensitive(value: string): string {
  return SECRET_PATTERNS.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), value);
}
