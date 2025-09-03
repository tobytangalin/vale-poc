// vale-native-bridge.js
// Purpose: Attempt to load a vale-native WASM build (produced by wasm-pack) and expose a uniform lint API.
// Fallback: Use provided JS substitution rules if WASM (or API) unavailable.

let wasmReady = false;
let wasmLintFn = null;
let initError = null;

// Static import required because dynamic import() is disallowed in ServiceWorkerGlobalScope.
// We assume the crate name is `vale_wasm` (copied from `vale-wasm/pkg`). If you change the crate
// name, update the import below and optionally adjust build script to copy the pkg directory.
// If the module is missing at load time the service worker will fail fast (which is preferable
// to a silent dynamic import failure later).
// eslint-disable-next-line import/no-relative-packages
import * as VALE_WASM_MODULE from './pkg/vale_wasm.js';

// Configuration assumptions:
// After running `wasm-pack build --target web --release` in the vale-native repo, copy the generated `pkg/` folder
// into `chrome-extension/`. Suppose crate name = `vale_native`; wasm-pack outputs:
//   pkg/vale_native.js
//   pkg/vale_native_bg.wasm
// This bridge will dynamically import the JS module and call an assumed exported function:
//   lint_text(text, rulesJson) -> stringified JSON diagnostics OR object/array.
// If the actual API differs, adapt `initializeWasm` accordingly.

export async function initializeWasm(rulesObject) {
  if (wasmReady || initError) return { wasmReady, initError };
  try {
    const wasmUrl = chrome.runtime.getURL('pkg/vale_wasm_bg.wasm');
    // Quick existence probe (optional guard).
    const head = await fetch(wasmUrl, { method: 'HEAD' });
    if (!head.ok) throw new Error(`WASM binary not found (status ${head.status}) at ${wasmUrl}`);

    if (typeof VALE_WASM_MODULE.default === 'function') {
      // New wasm-pack init signature prefers an options object.
      try {
        await VALE_WASM_MODULE.default({ module_or_path: wasmUrl });
      } catch (e) {
        // Fallback: older signature accepting path only.
        await VALE_WASM_MODULE.default(wasmUrl);
      }
    }
    // Some wasm-bindgen builds still attempt streaming; if CSP blocks, attempt manual instantiate.
    if (!wasmReady && typeof VALE_WASM_MODULE.__wbg_init === 'function' && !VALE_WASM_MODULE.lint_text && !VALE_WASM_MODULE.lint) {
      // Attempt manual initialization path (defensive; may be unnecessary)
      const resp = await fetch(wasmUrl);
      const bytes = await resp.arrayBuffer();
      try { await VALE_WASM_MODULE.__wbg_init(bytes); } catch {/* ignore */}
    }
    if (typeof VALE_WASM_MODULE.lint_text === 'function') {
      wasmLintFn = (text) => VALE_WASM_MODULE.lint_text(text, JSON.stringify(rulesObject));
    } else if (typeof VALE_WASM_MODULE.lint === 'function') {
      wasmLintFn = (text) => VALE_WASM_MODULE.lint(text, rulesObject);
    } else {
      throw new Error('No lint function exported (expected lint_text or lint)');
    }
    wasmReady = true;
  } catch (e) {
    initError = e;
    console.warn('[vale-native-bridge] WASM init failed, falling back to JS rules:', e);
  }
  return { wasmReady, initError };
}

export function lintWithWasm(text) {
  if (!wasmReady || !wasmLintFn) return null; // caller falls back
  try {
    const out = wasmLintFn(text);
    if (out == null) return [];
    if (Array.isArray(out)) { out.forEach(d=>d.__wasm=true); return out; }
    if (typeof out === 'string') {
      try { const arr = JSON.parse(out); if (Array.isArray(arr)) arr.forEach(d=>d.__wasm=true); return arr; } catch { return []; }
    }
    const diagArr = out.diagnostics || out.results || [];
    if (Array.isArray(diagArr)) diagArr.forEach(d=>d.__wasm=true);
    return diagArr;
  } catch (e) {
  console.warn('[vale-native-bridge] lint failed, reverting to fallback', e);
    return null;
  }
}
