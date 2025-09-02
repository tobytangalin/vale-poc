// Minimal unit tests for adaptiveDebounce, key filtering, simpleFastHash.
// Lightweight harness (no Jest) – run with: node test/unit/content-utils.test.mjs

import assert from 'assert';

// Re-implement small pure functions extracted from content.js for test (mirrors logic).
function adaptiveDebounceFactory(cfg){
  return function adaptiveDebounce(len){
    const base = cfg.debounceBase || 400;
    const factor = cfg.sizeFactor || 0;
    if (!len) return base;
    const bucket = Math.min(1, len / 2000);
    return base + Math.round(factor * bucket);
  };
}

function simpleFastHash(txt){ let h=0, step=Math.max(1,Math.floor(txt.length/64)); for(let i=0;i<txt.length;i+=step) h=(h*131 + txt.charCodeAt(i))>>>0; return h.toString(16); }

const NON_TEXT_CHANGE_KEYS = new Set([
  'Shift','Control','Alt','Meta','CapsLock','ArrowLeft','ArrowRight','ArrowUp','ArrowDown',
  'Escape','Tab','Home','End','PageUp','PageDown','Insert','NumLock','ScrollLock','ContextMenu',
  'F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12'
]);

function isTextChangingKey(e){
  if (NON_TEXT_CHANGE_KEYS.has(e.key)) return false;
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  return true;
}

// Tests
const debounce = adaptiveDebounceFactory({ debounceBase: 400, sizeFactor: 300 });
assert.strictEqual(debounce(0), 400, 'zero length uses base');
assert.ok(debounce(2000) >= 400 && debounce(2000) <= 700, 'max bucket adds factor');
assert.strictEqual(simpleFastHash(''), '0', 'empty hash');
assert.strictEqual(simpleFastHash('a'), simpleFastHash('a'), 'stable hash');
assert.notStrictEqual(simpleFastHash('a'), simpleFastHash('b'), 'different hash');
assert.ok(isTextChangingKey({ key: 'a' }), 'alpha key changes text');
assert.ok(!isTextChangingKey({ key: 'ArrowLeft' }), 'arrow left ignored');
assert.ok(!isTextChangingKey({ key: 'a', ctrlKey: true }), 'ctrl modified ignored');

console.log('All content-utils tests passed');