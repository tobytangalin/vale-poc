// Very small YAML extractor for the provided substitution rule file.
// Focuses only on lines under `swap:` mapping.

export function loadYamlRules(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  // Capture a simple top-level `level:` (first occurrence wins) prior to swap mapping.
  let topLevel = 'warning';
  for (const line of lines) {
    const m = line.match(/^level:\s*(\w+)/i);
    if (m) { topLevel = m[1].toLowerCase(); break; }
    if (/^\s*swap:\s*$/.test(line)) break; // stop searching once swap starts
  }
  const swapIndex = lines.findIndex(l => /^\s*swap:\s*$/.test(l));
  if (swapIndex === -1) return [];
  const rules = [];
  for (let i = swapIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s{2,}\S/.test(line)) break; // end of indented block
    const m = line.match(/^\s{2,}(.+?):\s*(.+)\s*$/);
    if (!m) continue;
    const from = m[1].trim();
    const to = m[2].trim();
    if (!from) continue;
    try {
      const pattern = new RegExp(`\\b${escapeRegex(from)}\\b`, 'gi');
      rules.push({ from, to, pattern, level: topLevel });
    } catch { /* ignore invalid */ }
  }
  return rules;
}

export function findDiagnostics(text, rules) {
  const diags = [];
  for (const r of rules) {
    r.pattern.lastIndex = 0;
    let match;
    while ((match = r.pattern.exec(text)) !== null) {
  // Skip if the exact substring already matches desired replacement (avoids lingering underline for case-only changes)
  if (match[0] === r.to) continue;
      diags.push({
        message: `Use '${r.to}' instead of '${match[0]}'`,
        start: match.index,
        end: match.index + match[0].length,
        replacement: r.to,
        rule: r.from,
        level: r.level || 'warning'
      });
      // Avoid infinite loops on zero-width
      if (r.pattern.lastIndex === match.index) r.pattern.lastIndex++;
    }
  }
  return diags;
}

function escapeRegex(s){return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
