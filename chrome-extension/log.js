// log.js - lightweight logging abstraction allowing silent/level control.
// Usage: import { log } from './log.js'; log.info('msg');

const LEVELS = { error:0, warn:1, info:2, debug:3 };
let currentLevel = 'info';

export function setLogLevel(lvl){ if (LEVELS[lvl] != null) currentLevel = lvl; }
function enabled(lvl){ return LEVELS[lvl] <= LEVELS[currentLevel]; }

export const log = {
  error: (...a)=> enabled('error') && console.error('[vale]', ...a),
  warn:  (...a)=> enabled('warn')  && console.warn('[vale]', ...a),
  info:  (...a)=> enabled('info')  && console.info('[vale]', ...a),
  debug: (...a)=> enabled('debug') && console.debug('[vale]', ...a)
};

// Auto elevate to debug if ?valeDebug=1 present in URL (content script only scenario)
try { if (typeof location !== 'undefined' && /[?&]valeDebug=1/.test(location.search)) currentLevel='debug'; } catch {}
