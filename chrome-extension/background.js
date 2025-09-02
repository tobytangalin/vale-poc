// Background service worker (MV3)
// Prototype: loads YAML substitution rules and performs naive text scans.
import { loadYamlRules, findDiagnostics } from './rules-loader.js';
import { RULE_FILES } from './rules-index.js';
import { initializeWasm, lintWithWasm } from './vale-native-bridge.js';

let rulesPromise; // Parsed substitution rules (aggregated) for fallback highlighting & metadata
let rawRulesPromise; // Raw YAML contents keyed by relative path for WASM
let wasmInitPromise; // Promise tracking WASM initialization

async function ensureRules() {
  if (!rulesPromise) {
    rulesPromise = (async () => {
      const all = [];
      for (const relative of RULE_FILES) {
        if (!/\.yml$/i.test(relative)) continue;
        try {
          const url = chrome.runtime.getURL('rules/' + relative);
          const text = await (await fetch(url)).text();
          const parsed = loadYamlRules(text) || [];
          // Attach source filename for reference
          parsed.forEach(r => { r.__file = relative; });
          all.push(...parsed);
        } catch (e) { console.warn('[vale] Failed to load rule file', relative, e); }
      }
      return all;
    })();
  }
  return rulesPromise;
}

async function ensureAllRawRules() {
  if (!rawRulesPromise) {
    rawRulesPromise = (async () => {
      const out = {};
      await Promise.all(RULE_FILES.map(async relative => {
        const url = chrome.runtime.getURL('rules/' + relative);
        try {
          const text = await (await fetch(url)).text();
          out[relative] = text;
        } catch(e){ console.warn('[vale] Failed to load rule', relative, e); }
      }));
      return out;
    })();
  }
  return rawRulesPromise;
}

async function ensureWasm() {
  if (!wasmInitPromise) {
    wasmInitPromise = (async () => {
      const allRaw = await ensureAllRawRules();
      // Pass raw YAML map to WASM bridge; bridge will adapt or fallback.
      return initializeWasm({ files: allRaw });
    })();
  }
  return wasmInitPromise;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return; // ignore

  const normalizeDiagnostics = (text, diags) => {
    if (!Array.isArray(diags)) return [];
    diags.forEach(d => {
      if (typeof d.start !== 'number' && d.span?.[0] != null) {
        d.start = d.span[0]; d.end = d.span[1];
      }
      if (typeof d.end !== 'number' && typeof d.start === 'number' && d.match) d.end = d.start + d.match.length;
      if (typeof d.start !== 'number' && (d.line != null || d.Line != null) && (d.Span || d.span)) {
        const lineNum = (d.line ?? d.Line) - 1; // 0-based
        const spanArr = d.Span || d.span;
        if (Array.isArray(spanArr) && spanArr.length >= 2) {
          const [colStart, colEnd] = spanArr; // 1-based columns typical
          const lines = text.split(/\n/);
            if (lineNum >=0 && lineNum < lines.length) {
              let offset = 0;
              for (let i=0;i<lineNum;i++) offset += lines[i].length + 1; // include newline
              d.start = offset + (colStart - 1);
              d.end = offset + (colEnd - 1);
            }
        }
      }
    });
    return diags;
  };

  const lintOne = async (text) => {
    const rules = await ensureRules();
    await ensureWasm();
    // Build quick lookup from rule 'from' token (lowercased) -> level
    const levelMap = new Map();
    rules.forEach(r => { if (r.from) levelMap.set(r.from.toLowerCase(), r.level || 'warning'); });
    let diags = lintWithWasm(text);
    if (diags == null || !Array.isArray(diags)) {
      diags = findDiagnostics(text, rules); // already assigns level
    } else {
      // Enrich WASM diagnostics lacking level using rule map (if rule name present)
      diags.forEach(d => {
        if (!d.level && d.rule && levelMap.has(String(d.rule).toLowerCase())) {
          d.level = levelMap.get(String(d.rule).toLowerCase());
        }
      });
    }
    return normalizeDiagnostics(text, diags);
  };

  if (msg.type === 'LINT') {
    (async () => {
      const diags = await lintOne(msg.text || '');
      const wasmReady = (await ensureWasm())?.wasmReady;
      sendResponse({ diagnostics: diags, engine: (wasmReady && diags.length) ? 'wasm' : 'fallback' });
    })();
    return true; // async
  }

  if (msg.type === 'LINT_BLOCKS') {
    (async () => {
      const texts = Array.isArray(msg.texts) ? msg.texts : [];
      const results = await Promise.all(texts.map(t => lintOne(t)));
      const wasmReady = (await ensureWasm())?.wasmReady;
      sendResponse({ results, engine: (wasmReady && results.some(r => r.length)) ? 'wasm' : 'fallback' });
    })();
    return true; // async
  }
});
