// diagnostic-normalizer.mjs
// Normalize various Vale diagnostic output (CLI JSON vs hypothetical WASM) into a unified shape.
// Target shape:
// { rule: string, message: string, severity: string, start: number, end: number, line: number, spanText?: string, suggestion?: string }

export function normalizeDiagnostics(raw, originalText) {
  if (!raw) return [];
  // If raw is already an array of objects with start/end treat directly.
  if (Array.isArray(raw)) return raw.map(d => coerce(d, originalText));
  if (raw.diagnostics) return raw.diagnostics.map(d => coerce(d, originalText));
  if (raw.results) return raw.results.map(d => coerce(d, originalText));
  return [];
}

function coerce(d, text) {
  const start = typeof d.start === 'number' ? d.start : (Array.isArray(d.span) ? d.span[0] : undefined);
  let end = typeof d.end === 'number' ? d.end : (Array.isArray(d.span) ? d.span[1] : undefined);
  if (start != null && (end == null) && typeof d.match === 'string') {
    end = start + d.match.length;
  }
  const out = {
    rule: d.rule || d.Rule || d.id || 'UnknownRule',
    message: d.message || d.Message || d.description || '',
    severity: (d.severity || d.Severity || 'warning').toLowerCase(),
    start,
    end,
    line: d.line || d.Line || 0,
  };
  if (start != null && end != null && text) out.spanText = text.slice(start, end);
  if (d.replacement || d.suggestion) out.suggestion = d.replacement || d.suggestion;
  return out;
}
