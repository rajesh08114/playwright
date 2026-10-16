const SECRET_PATTERNS = [
  /(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi,
  /(cookie\s*[:=]\s*)[^\s;]+/gi,
  /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\s*[:=]\s*)[^\s,;]+/gi,
  /(\b(?:sk|pk)_[A-Za-z0-9_-]{12,})/g
];
export function redactSensitive(value: string): string { return SECRET_PATTERNS.reduce((result, pattern) => result.replace(pattern, "$1[REDACTED]"), value); }
