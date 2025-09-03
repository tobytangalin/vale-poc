(()=>{
// Inline minimal logger (content script runs as classic script, cannot use static import reliably across all Chrome versions)
const log = (()=>{ const LEVELS={error:0,warn:1,info:2,debug:3}; let lvl='info'; try { if (/[?&]valeDebug=1/.test(location.search)) lvl='debug'; } catch{} const en=l=>LEVELS[l]<=LEVELS[lvl]; return { error:(...a)=>en('error')&&console.error('[vale]',...a), warn:(...a)=>en('warn')&&console.warn('[vale]',...a), info:(...a)=>en('info')&&console.info('[vale]',...a), debug:(...a)=>en('debug')&&console.debug('[vale]',...a) }; })();
// Scope guard: only activate on Paligo edit pages
try {
  if (!/\/document\/edit\//.test(location.pathname)) {
    log.debug('Skipping Vale content script: not an edit page');
    return; // abort entire IIFE
  }
} catch(_) {}
// Content script: watches active editable element and requests linting (IIFE isolated scope).
let timer; let lastValue = '';
const CONFIG_DEFAULTS = { enabled: true, manualMode: false, debounceBase: 400, sizeFactor: 300, severity: { error:true, warning:true, suggestion:true } };
let userConfig = { ...CONFIG_DEFAULTS };
// Safe wrappers for chrome.storage operations to avoid uncaught 'Extension context invalidated' errors
function safeStorageGet(defaults, cb){
  try {
    if (chrome?.storage?.sync?.get) chrome.storage.sync.get(defaults, cfg => { try { cb && cb(cfg); } catch(e){} });
  } catch (e) {
    if (/Extension context invalidated/i.test(e.message||'')) { extensionInvalidated = true; startRuntimeRecovery(); }
  }
}
function safeStorageSet(obj){
  try { if (chrome?.storage?.sync?.set) chrome.storage.sync.set(obj); }
  catch(e){ if (/Extension context invalidated/i.test(e.message||'')) { extensionInvalidated = true; startRuntimeRecovery(); } }
}
safeStorageGet(CONFIG_DEFAULTS, cfg => { userConfig = { ...CONFIG_DEFAULTS, ...cfg }; });
chrome.storage?.onChanged?.addListener(changes => {
  const prevManual = userConfig.manualMode;
  for (const k in changes) userConfig[k] = changes[k].newValue;
  if (prevManual !== userConfig.manualMode) {
    if (userConfig.manualMode) {
      if (!panelState.panelEl) createDiagnosticsPanel();
    } else if (userConfig.enabled) {
      initialKick('manualMode-disabled');
    }
    updateRunButtonUI();
  }
});
// Forward declarations for flags referenced early.
var extensionInvalidated = false; // will be reused/reassigned later in safe messaging section
var loggedInvalidation = false;
let pageHiddenPaused = false; // Track pause state when document hidden

// Simple fast hash for caching
function simpleFastHash(txt){ let h=0, step=Math.max(1,Math.floor(txt.length/64)); for(let i=0;i<txt.length;i+=step) h=(h*131 + txt.charCodeAt(i))>>>0; return h.toString(16); }

function adaptiveDebounce(len){
  const base = userConfig.debounceBase || 400;
  const factor = userConfig.sizeFactor || 0;
  if (!len) return base;
  const bucket = Math.min(1, len / 2000);
  return base + Math.round(factor * bucket);
}
// (Removed inputDiagMap: diagnostics stored directly in panelState only)

function getEditableElement() {
  const el = document.activeElement;
  if (!el) return null;
  if (el.isContentEditable) return el;
  if (['TEXTAREA','INPUT'].includes(el.tagName) && el.type === 'text' || el.tagName==='TEXTAREA') return el;
  return null;
}

function currentText() { const el = getEditableElement(); return el ? (el.isContentEditable ? el.textContent : el.value) : ''; }

function schedule(targetLen) { clearTimeout(timer); timer = setTimeout(runLint, adaptiveDebounce(targetLen||currentText().length)); }
// Backoff-aware scheduling wrapper that tolerates extension context invalidation.
let backoffMs = 0; let backoffTimer = null; let nextAttempt = 0;
function safeSchedule(targetLen) {
  if (!userConfig.enabled || userConfig.manualMode) return; // respect enabled flag & manual mode suppression
  if (extensionInvalidated) {
    const now = Date.now();
    if (now < nextAttempt) return; // still waiting
    backoffMs = backoffMs === 0 ? 300 : Math.min(backoffMs * 2, 5000);
    nextAttempt = now + backoffMs;
    clearTimeout(backoffTimer);
    backoffTimer = setTimeout(() => {
      if (!extensionInvalidated) { backoffMs = 0; nextAttempt = 0; schedule(targetLen); }
      else safeSchedule(targetLen);
    }, backoffMs);
    return;
  }
  if (backoffTimer) { clearTimeout(backoffTimer); backoffTimer = null; }
  backoffMs = 0; nextAttempt = 0;
  schedule(targetLen);
}

function runLint({ force=false }={}) {
  if ((!userConfig.enabled || userConfig.manualMode) && !force) return;
  // Paligo root detection
  const paligoRoot = detectPaligoRoot();
  if (paligoRoot && document.activeElement === paligoRoot) {
    paligoSelective.init(paligoRoot);
    paligoSelective.schedule();
    return;
  }
  const text = currentText();
  if (text === lastValue || !text) return;
  lastValue = text;
  safeSendMessage({ type: 'LINT', text }, resp => {
    if (!resp) return; recordActiveContentEditableDiagnostics(resp.diagnostics);
  });
}

// Records diagnostics for the currently active editable (contentEditable or input/textarea).
function recordActiveContentEditableDiagnostics(diags) {
  // Panel-only mode: no destructive DOM mutation.
  const el = getEditableElement();
  if (!el) return;
  if (!el.isContentEditable) { handleInputDiagnostics(el, diags); return; }
  panelState.genericCE = { el, diags };
  schedulePanelUpdate();
}

// ===== Key filtering (ignore keys that don't change text) =====
const NON_TEXT_CHANGE_KEYS = new Set([
  'Shift','Control','Alt','Meta','CapsLock','ArrowLeft','ArrowRight','ArrowUp','ArrowDown',
  'Escape','Tab','Home','End','PageUp','PageDown','Insert','NumLock','ScrollLock','ContextMenu',
  'F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12'
]);
document.addEventListener('keyup', (e) => {
  if (NON_TEXT_CHANGE_KEYS.has(e.key)) return;
  // If modifiers are held (except Shift which is already filtered) we skip.
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (!userConfig.enabled || userConfig.manualMode) return;
  const txt = currentText();
  if (txt === lastValue) return; // No textual change since last lint.
  safeSchedule(txt.length);
}, true);
document.addEventListener('focus', e=>{ if (getEditableElement() && !userConfig.manualMode) safeSchedule(); }, true);

// ===== Input/Textarea handling =====
function handleInputDiagnostics(el, diags) {
  const summary = diags.map(d=>d.message).join('\n');
  if (summary) el.setAttribute('title', summary); else el.removeAttribute('title');
  // Inline style instead of class (class removed)
  if (diags.length) {
    if (!el.dataset._origOutline) el.dataset._origOutline = el.style.outline || '';
    el.style.outline = '2px dotted #d00';
  } else if (el.dataset._origOutline !== undefined) {
    el.style.outline = el.dataset._origOutline;
  }
  if (diags.length) panelState.inputs.set(el, diags); else panelState.inputs.delete(el);
  schedulePanelUpdate();
}
// (Overlays & undo stack removed)

// ===== Paligo Adapter (inline minimal) =====
function detectPaligoRoot(){
  const el = document.getElementById('document');
  if (!el) return null;
  if (!el.isContentEditable) return null;
  if (!el.classList.contains('editor-document')) return null;
  return el;
}

// (Removed collectPaligoBlocks & paligoBlockText as highlighting removed)

// (createDiagRanges removed from global scope; created on-demand inside focusDiagnostic)

function registerPaligoDiagnostics(blockEl, diags){
  if (Array.isArray(diags) && diags.length) panelState.paligo.set(blockEl, diags); else panelState.paligo.delete(blockEl);
  schedulePanelUpdate();
}

// (Overlay reposition logic removed)

// ================= Diagnostics Panel =================
const panelState = {
  paligo: new Map(), // blockEl -> diags
  inputs: new Map(), // input/textarea -> diags
  genericCE: null,
  panelEl: null,
  pending: false,
  entries: [],
  // theme: 'system' // Theme support removed per request
};
let runtimeFailure = false; // surfaced when recovery times out
let panelNavIndex = -1;

function schedulePanelUpdate(){
  if (panelState.pending) return; panelState.pending = true;
  requestAnimationFrame(()=>{ panelState.pending = false; rebuildDiagnosticsPanel(); });
}

function rebuildDiagnosticsPanel(){
  // Prune disconnected elements
  for (const [el] of [...panelState.paligo]) if (!el.isConnected) panelState.paligo.delete(el);
  for (const [el] of [...panelState.inputs]) if (!el.isConnected) panelState.inputs.delete(el);
  if (panelState.genericCE && !panelState.genericCE.el.isConnected) panelState.genericCE = null;

  const entries = [];
  panelState.paligo.forEach((diags, el) => diags.forEach(d=>entries.push({source:'block', el, diag:d})));
  panelState.inputs.forEach((diags, el) => diags.forEach(d=>entries.push({source:'input', el, diag:d})));
  if (panelState.genericCE) panelState.genericCE.diags.forEach(d=>entries.push({source:'contentEditable', el: panelState.genericCE.el, diag:d}));
  const sevCfg = (userConfig.severity) ? {
    error: userConfig.severity.error !== false,
    warning: userConfig.severity.warning !== false,
    suggestion: userConfig.severity.suggestion !== false
  } : CONFIG_DEFAULTS.severity;
  const filtered = entries.filter(e => {
    const lvl = (e.diag.level || e.diag.Level || e.diag.severity || e.diag.Severity || 'warning').toString().toLowerCase();
    if (lvl === 'error') return sevCfg.error;
    if (lvl === 'suggestion') return sevCfg.suggestion;
  if (lvl === 'info') return false; // info suppressed (removed)
    return sevCfg.warning; // default bucket
  });
  panelState.entries = filtered; // navigation reflects filtered

  // Always keep panel visible (even with zero issues) so user sees the result of a manual lint.
  if (!panelState.panelEl) createDiagnosticsPanel();
  const panel = panelState.panelEl; panel.style.display='flex';
  const listEl = panel.querySelector('.vale-panel-list');
  listEl.innerHTML = '';
  const MAX = 500;
  filtered.slice(0,MAX).forEach((e,i)=>{
    const item = document.createElement('div');
    Object.assign(item.style, { padding:'2px 4px', borderRadius:'4px', margin:'1px 0', cursor:'pointer', display:'flex', gap:'4px', alignItems:'flex-start' });
    const msg = (e.diag.message||'Issue').replace(/[\r\n]+/g,' ');
    const levelRaw = (e.diag.level || e.diag.Level || e.diag.severity || e.diag.Severity || '').toString().toLowerCase();
    let iconChar = '';
    let iconColor = '';
    switch(levelRaw){
      case 'error': iconChar='⛔'; iconColor='#ff5555'; break;
      case 'warning': iconChar='⚠️'; iconColor='#ffca28'; break;
      case 'suggestion': iconChar='💡'; iconColor='#ffd54f'; break;
  case 'info': iconChar=''; iconColor=''; break; // suppressed
      default: iconChar='•'; iconColor='#aaa';
    }
    const iconSpan = document.createElement('span');
    iconSpan.textContent = iconChar;
    Object.assign(iconSpan.style, { flex:'0 0 auto', width:'1.2em', textAlign:'center', color:iconColor, filter:'drop-shadow(0 0 1px rgba(0,0,0,0.4))' });
    iconSpan.setAttribute('aria-hidden','true');
    const textSpan = document.createElement('span');
    textSpan.textContent = msg + (e.diag.replacement?` → ${e.diag.replacement}`:'');
    item.appendChild(iconSpan);
    item.appendChild(textSpan);
    const titleParts = [msg];
  if (levelRaw) titleParts.unshift(levelRaw.toUpperCase());
    if (e.diag.replacement) titleParts.push('(Click Apply button to apply replacement)');
    item.title = titleParts.join(' - ');
    item.dataset.index = i;
    item.addEventListener('click', () => focusDiagnostic(e));
    if (e.diag.replacement) {
      const btn = document.createElement('button');
      btn.textContent = 'Apply';
      btn.className = 'vale-apply-btn';
      Object.assign(btn.style, { marginLeft:'auto', background:'#444', color:'#fff', border:'1px solid #666', borderRadius:'4px', fontSize:'11px', lineHeight:'1.2', padding:'2px 6px', cursor:'pointer' });
      btn.addEventListener('click', ev=>{ ev.stopPropagation(); applyReplacement(e); });
      btn.title = 'Apply replacement';
      btn.setAttribute('aria-label','Apply replacement');
      item.appendChild(btn);
    }
    item.setAttribute('role','button'); item.tabIndex=-1;
    listEl.appendChild(item);
  });
  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:6px; opacity:0.65; font-style:italic;';
    empty.textContent = 'No issues found';
    listEl.appendChild(empty);
  }
  if (filtered.length > MAX) {
    const remain = filtered.length - MAX;
    const trunc = document.createElement('div');
    trunc.style.cssText = 'padding:4px; font-style:italic; opacity:0.8;';
    trunc.textContent = `…truncated (${remain} more)`;
    listEl.appendChild(trunc);
  }
  if (runtimeFailure) {
    const err = document.createElement('div');
    err.style.cssText = 'padding:4px; font-weight:600; color:#ffb347;';
    err.textContent = 'Refresh page to restore linting (extension context lost)';
    listEl.appendChild(err);
  }
  const countEl = panel.querySelector('.vale-panel-count');
  if (filtered.length === entries.length) {
    countEl.textContent = filtered.length + ' issue' + (filtered.length!==1?'s':'');
  } else {
    countEl.textContent = `${filtered.length}/${entries.length} issues`;
  }
  // Reset navigation index if out of range
  if (panelNavIndex >= filtered.length) panelNavIndex = filtered.length-1;
  applyPanelKeyboardState();
}

// Load persisted panel UI state
let persistedPanelState = { right: 12, bottom: 12, collapsed: false };
safeStorageGet({ _valePanel: persistedPanelState }, data => {
  if (data && data._valePanel) persistedPanelState = { ...persistedPanelState, ...data._valePanel };
  // panelState.theme = persistedPanelState.theme || 'system'; // Theme support removed per request
});

function persistPanel(){
  safeStorageSet({ _valePanel: persistedPanelState });
}

// (Theme support removed per request)

function createDiagnosticsPanel(){
  const panel = document.createElement('div');
  panel.className = 'vale-diagnostics-panel';
  panel.innerHTML = `\n    <div class="vale-panel-header">\n      <span class="vale-panel-title">Vale</span>\n      <span class="vale-panel-count">0</span>\n      <button class="vale-panel-run" title="Run manual lint now" style="margin-left:auto;">Lint</button>\n      <button class="vale-panel-toggle" title="Collapse">−</button>\n    </div>\n    <div class="vale-panel-list"></div>\n  `;
  Object.assign(panel.style, {
    position:'fixed', right: persistedPanelState.right + 'px', bottom: persistedPanelState.bottom + 'px', width:'280px', maxHeight:'40vh',
    background:'rgba(32,32,36,0.90)', color:'#fff', font:'12px/1.4 sans-serif',
    boxShadow:'0 4px 12px rgba(0,0,0,0.4)', borderRadius:'6px', zIndex:999999,
    display:'flex', flexDirection:'column', backdropFilter:'blur(4px)',
  });
  const list = panel.querySelector('.vale-panel-list');
  Object.assign(list.style, { overflowY:'auto', padding:'4px 6px', flex:'1 1 auto' });
  const header = panel.querySelector('.vale-panel-header');
  Object.assign(header.style, { display:'flex', alignItems:'center', gap:'8px', padding:'4px 6px', cursor:'move' });
  header.querySelector('.vale-panel-title').style.fontWeight='600';
  const toggleBtn = header.querySelector('.vale-panel-toggle');
  const runBtn = header.querySelector('.vale-panel-run');
  Object.assign(toggleBtn.style, { background:'transparent', color:'#fff', border:'none', cursor:'pointer', fontSize:'14px' });
  // Enhanced Lint button styling
  Object.assign(runBtn.style, {
    background: 'linear-gradient(135deg,#2563eb,#1d4ed8)',
    color: '#fff',
    border: '1px solid #1e3a8a',
    borderRadius: '999px',
    padding: '3px 12px 4px',
    fontSize: '11px',
    fontWeight: '600',
    letterSpacing: '.5px',
    fontFamily: 'inherit',
    cursor: 'pointer',
    lineHeight: '1.1',
    transition: 'background .18s, box-shadow .18s, transform .15s',
    boxShadow: '0 2px 4px rgba(0,0,0,0.25), inset 0 0 0 0 rgba(255,255,255,0.15)'
  });
  runBtn.addEventListener('mouseenter', () => { if (runBtn.disabled) return; runBtn.style.background = 'linear-gradient(135deg,#1d4ed8,#1e40af)'; });
  runBtn.addEventListener('mouseleave', () => { if (runBtn.disabled) return; runBtn.style.background = 'linear-gradient(135deg,#2563eb,#1d4ed8)'; });
  runBtn.addEventListener('mousedown', () => { if (runBtn.disabled) return; runBtn.style.transform = 'translateY(1px)'; });
  runBtn.addEventListener('mouseup', () => { runBtn.style.transform = 'translateY(0)'; });
  runBtn.addEventListener('focus', () => { runBtn.style.boxShadow = '0 0 0 2px #fff, 0 0 0 4px rgba(37,99,235,0.7)'; });
  runBtn.addEventListener('blur', () => { runBtn.style.boxShadow = '0 2px 4px rgba(0,0,0,0.25), inset 0 0 0 0 rgba(255,255,255,0.15)'; });
  toggleBtn.addEventListener('click', () => {
    const listVisible = list.style.display !== 'none';
    list.style.display = listVisible ? 'none' : 'block';
    toggleBtn.textContent = listVisible ? '+' : '−';
    persistedPanelState.collapsed = !listVisible;
    persistPanel();
  });
  runBtn.addEventListener('click', () => { if (!manualRunPending) manualFullLint(); });
  if (persistedPanelState.collapsed) {
  // Override: always start expanded by default now.
  // If user previously collapsed in an earlier session, we reset to expanded.
  persistedPanelState.collapsed = false;
  toggleBtn.textContent = '−';
  list.style.display = 'block';
  persistPanel();
  }
  // Simple drag to move
  let drag=false, sx=0, sy=0, startRight=0, startBottom=0;
  header.addEventListener('mousedown', e=>{ drag=true; sx=e.clientX; sy=e.clientY; startRight=parseInt(panel.style.right); startBottom=parseInt(panel.style.bottom); e.preventDefault(); });
  window.addEventListener('mousemove', e=>{ if(!drag) return; const dx=sx-e.clientX; const dy=sy-e.clientY; const nr=(startRight+dx); const nb=(startBottom+dy); panel.style.right=nr+'px'; panel.style.bottom=nb+'px'; persistedPanelState.right = nr; persistedPanelState.bottom = nb; });
  window.addEventListener('mouseup', ()=>{ if(drag){ persistPanel(); } drag=false; });
  document.documentElement.appendChild(panel);
  panelState.panelEl = panel;
  panel.tabIndex = 0; // focusable container
  // Accessibility attributes
  panel.setAttribute('role','region');
  panel.setAttribute('aria-label','Vale diagnostics');
  panel.querySelector('.vale-panel-count').setAttribute('aria-live','polite');
  panel.addEventListener('keydown', panelKeyHandler);

  // ---- Severity Filter Bar ----
  const sevBar = document.createElement('div');
  Object.assign(sevBar.style, { display:'flex', gap:'6px', padding:'2px 6px 4px', alignItems:'center', borderTop:'1px solid rgba(255,255,255,0.08)', fontSize:'11px' });
  const makeChk = (key, labelTxt, title) => {
    const wrap = document.createElement('label');
    Object.assign(wrap.style, { display:'flex', alignItems:'center', gap:'2px', cursor:'pointer' });
  const cb = document.createElement('input'); cb.type='checkbox'; cb.checked = userConfig.severity?.[key] !== false;
    cb.addEventListener('change', ()=>{
      const sev = { ...(userConfig.severity||CONFIG_DEFAULTS.severity) };
      sev[key] = cb.checked;
      userConfig.severity = sev;
  safeStorageSet({ severity: sev });
      // Just rebuild panel client-side; no need to re-lint
      schedulePanelUpdate();
    });
    wrap.appendChild(cb);
    const span = document.createElement('span'); span.textContent = labelTxt; span.style.userSelect='none'; span.title = title;
    wrap.appendChild(span);
    return wrap;
  };
  const barItems = document.createElement('div');
  Object.assign(barItems.style, { display:'flex', gap:'8px', flexWrap:'wrap' });
  barItems.appendChild(makeChk('error','Err','Show errors'));
  barItems.appendChild(makeChk('warning','Warn','Show warnings'));
  barItems.appendChild(makeChk('suggestion','Sug','Show suggestions'));
  const barTitle = document.createElement('span'); barTitle.textContent='Filter:'; barTitle.style.opacity='0.7';
  sevBar.appendChild(barTitle); sevBar.appendChild(barItems);
  panel.insertBefore(sevBar, panel.querySelector('.vale-panel-list'));
  updateRunButtonUI();
}

// Manual mode trigger: lint active element or all Paligo blocks on demand.
let manualRunPending = false;
function manualFullLint(){
  if (!userConfig.enabled) return;
  manualRunPending = true; updateRunButtonUI();
  panelState.paligo.clear(); panelState.inputs.clear(); panelState.genericCE = null; panelState.entries = []; schedulePanelUpdate();
  const root = detectPaligoRoot();
  if (root) {
    // Collect all blocks and send batch lint.
    const blocks = [...root.querySelectorAll(paligoSelective.blockSelector)];
    const texts = blocks.map(b => b.textContent || '');
    // Filter empties to reduce traffic but maintain index alignment by keeping placeholders
    safeSendMessage({ type: 'LINT_BLOCKS', texts }, resp => {
      if (resp && Array.isArray(resp.results)) {
        resp.results.forEach((diags, i) => {
          const el = blocks[i]; if (!el) return; registerPaligoDiagnostics(el, diags || []);
        });
      }
      manualRunPending = false; updateRunButtonUI();
    });
    return;
  }
  // Fallback: active editable only.
  const el = getEditableElement();
  if (!el) { schedulePanelUpdate(); return; }
  lastValue='';
  if (el.isContentEditable) {
    const text = el.textContent || '';
    safeSendMessage({ type: 'LINT', text }, resp => { if (resp) recordActiveContentEditableDiagnostics(resp.diagnostics); manualRunPending=false; updateRunButtonUI(); });
  } else {
    const text = el.value || '';
    safeSendMessage({ type: 'LINT', text }, resp => { if (resp) recordActiveContentEditableDiagnostics(resp.diagnostics); manualRunPending=false; updateRunButtonUI(); });
  }
}

function updateRunButtonUI(){
  if (!panelState.panelEl) return;
  const btn = panelState.panelEl.querySelector('.vale-panel-run');
  if (!btn) return;
  const manual = !!userConfig.manualMode;
  btn.style.display = manual ? 'inline-block' : 'none';
  if (manualRunPending) {
    btn.disabled = true;
    btn.textContent = 'Linting…';
    btn.style.opacity = '0.75';
    btn.style.cursor = 'wait';
  } else {
    btn.disabled = false;
  btn.textContent = 'Lint';
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
  }
}

function panelKeyHandler(e){
  if (e.key === 'Escape') {
    const toggleBtn = panelState.panelEl.querySelector('.vale-panel-toggle');
    toggleBtn.click();
    return;
  }
  if (!panelState.entries.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (panelNavIndex < 0) panelNavIndex = 0;
    else panelNavIndex += (e.key === 'ArrowDown' ? 1 : -1);
    if (panelNavIndex < 0) panelNavIndex = panelState.entries.length -1;
    if (panelNavIndex >= panelState.entries.length) panelNavIndex = 0;
    applyPanelKeyboardState();
  } else if (e.key === 'Enter' && panelNavIndex >=0) {
    const entry = panelState.entries[panelNavIndex];
    focusDiagnostic(entry);
  }
}

function applyPanelKeyboardState(){
  if (!panelState.panelEl) return;
  const listEl = panelState.panelEl.querySelector('.vale-panel-list');
  const items = [...listEl.querySelectorAll('[data-index]')];
  items.forEach(it => {
    const idx = +it.dataset.index;
    if (idx === panelNavIndex) {
      it.style.background = '#333';
      it.tabIndex = 0;
    } else {
      it.style.background = '';
      it.tabIndex = -1;
    }
  });
  const active = items.find(it => +it.dataset.index === panelNavIndex);
  if (active) active.focus();
}

// === Range cache for fast selection ===
const rangeCache = new WeakMap(); // root -> { hash, nodes:[{node,start,len}] }
function buildRangeCache(root, timeBudgetMs=5){
  const tStart = performance.now();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode(n){ return n.nodeValue.trim()?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT; } });
  const nodes=[]; let global=0; let n;
  while((n=walker.nextNode())){
    const len = n.nodeValue.length;
    nodes.push({ node:n, start:global, len });
    global += len;
    if ((performance.now()-tStart) > timeBudgetMs) return null; // abort build
  }
  const entry = { hash: simpleFastHash(root.textContent||''), nodes };
  rangeCache.set(root, entry);
  return entry;
}

function focusDiagnostic(entry){
  if (!entry.el || !entry.el.isConnected) return;
  entry.el.scrollIntoView({block:'center', behavior:'smooth'});
  try {
    function rangeForDiag(root, diag){
      if (typeof diag.start !== 'number' || typeof diag.end !== 'number') return null;
      let cache = rangeCache.get(root);
      const currentHash = simpleFastHash(root.textContent||'');
      if (!cache || cache.hash !== currentHash) {
        cache = buildRangeCache(root, 5);
        if (!cache) return null; // abort if time budget exceeded
      }
      let startNode=null,startOffset=0,endNode=null,endOffset=0;
      for (const seg of cache.nodes){
        const segEnd = seg.start + seg.len;
        if (!startNode && diag.start >= seg.start && diag.start < segEnd){ startNode=seg.node; startOffset = diag.start - seg.start; }
        if (!endNode && diag.end > seg.start && diag.end <= segEnd){ endNode=seg.node; endOffset = diag.end - seg.start; }
        if (startNode && endNode) break;
      }
      if (startNode && !endNode){ endNode=startNode; endOffset=startNode.nodeValue.length; }
      if (!startNode || !endNode) return null;
      const r=document.createRange();
      try { r.setStart(startNode,startOffset); r.setEnd(endNode,endOffset); } catch { return null; }
      return r;
    }
    const r = rangeForDiag(entry.el, entry.diag);
    if (r){ const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(r); }
  } catch(_){}
  // Inline flash (no stylesheet or class)
  const prev = entry.el.style.outline;
  entry.el.style.outline = '2px solid #ff0';
  setTimeout(()=>{ entry.el.style.outline = prev; }, 600);
}

// (Old destructive applyPaligoDiagnostics removed in favor of overlay approach above)

// (Selection preservation helpers removed for lighter runtime)

// Paligo selective hashing + observer
const paligoSelective = {
  root: null,
  observer: null,
  dirty: new Set(),
  hashMap: new Map(),
  blockSelector: 'div.translation.default.block[data-element]',
  batchTimer: null,
  init(root){
    if (!userConfig.enabled) return;
    if (!this.root) this.root = root;
    if (!this.observer) {
      this.observer = new MutationObserver(muts => {
        muts.forEach(m => {
          if (m.type === 'characterData' && m.target.parentElement) {
            const blk = m.target.parentElement.closest(this.blockSelector); if (blk) this.mark(blk);
          }
          if (m.type === 'childList') {
            [...m.addedNodes, ...m.removedNodes].forEach(n => {
              if (n.nodeType !== 1) return;
              if (n.matches?.(this.blockSelector)) this.mark(n);
              else if (n.querySelector) n.querySelectorAll(this.blockSelector).forEach(b=>this.mark(b));
            });
            const parentBlk = m.target.closest?.(this.blockSelector); if (parentBlk) this.mark(parentBlk);
          }
        });
        this.schedule();
      });
      this.observer.observe(root, { subtree: true, characterData: true, childList: true });
      // Initial mark all
      root.querySelectorAll(this.blockSelector).forEach(b=>this.mark(b));
    }
  },
  mark(el){
    if (el.classList.contains('verbatim') || el.classList.contains('dont-translate')) return;
    const id = el.getAttribute('data-attr-xinfo-text') || el.dataset.blockHashId || (el.dataset.blockHashId = Math.random().toString(36).slice(2));
    this.dirty.add(id);
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(()=>{ this.batchTimer=null; this.lintDirty(); }, 70); // batching window
    }
  },
  simpleHash(txt){
    let sum = 0; const step = Math.max(1, Math.floor(txt.length / 64));
    for (let i=0;i<txt.length;i+=step) sum = (sum + txt.charCodeAt(i)*31) & 0xfffffff;
    return `${txt.length}|${sum.toString(16)}|${txt.slice(0,8)}|${txt.slice(-8)}`;
  },
  schedule(){
    clearTimeout(this.timer);
    if (!userConfig.enabled) return;
  const len = this.root ? (this.root.textContent ? this.root.textContent.length : 0) : 0;
    this.timer = setTimeout(()=> this.lintDirty(), adaptiveDebounce(len));
  },
  lintDirty(){
    if (!this.root || !this.dirty.size || !userConfig.enabled) return;
    const blocks = this.root.querySelectorAll(this.blockSelector);
    const reqTexts = []; const elements = [];
    blocks.forEach(b => {
      const id = b.getAttribute('data-attr-xinfo-text') || b.dataset.blockHashId; if (!id || !this.dirty.has(id)) return;
      const text = b.textContent || '';
      if (!text.trim()) { panelState.paligo.delete(b); this.dirty.delete(id); return; }
      const h = this.simpleHash(text); const prev = this.hashMap.get(id);
      if (prev && prev === h) { this.dirty.delete(id); return; }
      this.hashMap.set(id, h);
      reqTexts.push(text); elements.push(b);
      this.dirty.delete(id);
    });
    if (!reqTexts.length) { schedulePanelUpdate(); return; }
    safeSendMessage({ type: 'LINT_BLOCKS', texts: reqTexts }, resp => {
      if (!resp || !Array.isArray(resp.results)) return;
      resp.results.forEach((diags, i) => {
        const el = elements[i]; if (!el) return; registerPaligoDiagnostics(el, diags || []);
      });
    });
  }
};

// ---- Safe messaging wrapper to avoid 'Extension context invalidated' errors ----
function safeSendMessage(msg, cb){
  try {
    if (!(chrome && chrome.runtime && chrome.runtime.id)) {
      // runtime not yet ready or invalidated
      if (!extensionInvalidated) {
        extensionInvalidated = true;
        if (!loggedInvalidation) { log.debug('runtime id not available yet; deferring message'); loggedInvalidation = true; }
        startRuntimeRecovery();
      }
      return;
    }
    chrome.runtime.sendMessage(msg, resp => {
      if (chrome.runtime.lastError) {
        const txt = chrome.runtime.lastError.message || '';
        if (!loggedInvalidation && /Extension context invalidated/i.test(txt)) {
          log.warn('message skipped (context invalidated)');
          loggedInvalidation = true; extensionInvalidated = true;
          startRuntimeRecovery();
        }
        return cb && cb(undefined);
      }
      if (extensionInvalidated) {
        extensionInvalidated = false; loggedInvalidation = false; backoffMs=0; nextAttempt=0; if (backoffTimer){ clearTimeout(backoffTimer); backoffTimer=null; }
        const root = detectPaligoRoot(); if (root) { paligoSelective.init(root); paligoSelective.schedule(); } else safeSchedule();
      }
      cb && cb(resp);
    });
  } catch (e) {
    extensionInvalidated = true;
  if (!loggedInvalidation) { log.warn('sendMessage failed', e); loggedInvalidation = true; }
    startRuntimeRecovery();
  }
}

// Periodic recovery loop: poll for chrome.runtime.id returning, then reinitialize.
let runtimeRecoveryInterval = null; let runtimeRecoveryAttempts = 0;
function startRuntimeRecovery(){
  if (runtimeRecoveryInterval) return; // already running
  runtimeRecoveryAttempts = 0;
  runtimeRecoveryInterval = setInterval(()=>{
    runtimeRecoveryAttempts++;
    if (chrome.runtime?.id) {
      clearInterval(runtimeRecoveryInterval); runtimeRecoveryInterval=null;
      const attempts = runtimeRecoveryAttempts; runtimeRecoveryAttempts=0;
  log.info('runtime recovered after', attempts, 'attempts');
  extensionInvalidated = false; loggedInvalidation = false; backoffMs=0; nextAttempt=0; if (backoffTimer){ clearTimeout(backoffTimer); backoffTimer=null; }
      const root = detectPaligoRoot(); if (root) { paligoSelective.init(root); paligoSelective.schedule(); } else safeSchedule();
    } else if (runtimeRecoveryAttempts >= 30) { // ~60s @2s interval
      clearInterval(runtimeRecoveryInterval); runtimeRecoveryInterval=null;
  log.warn('runtime recovery timed out');
  runtimeFailure = true; schedulePanelUpdate();
    }
  }, 2000);
}

// Recovery when tab becomes visible again
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    clearTimeout(timer); timer=null; pageHiddenPaused = true;
  } else if (document.visibilityState === 'visible') {
    if (extensionInvalidated && chrome.runtime?.id) {
      extensionInvalidated = false; loggedInvalidation = false; backoffMs=0; nextAttempt=0; if (backoffTimer){ clearTimeout(backoffTimer); backoffTimer=null; }
      const root = detectPaligoRoot(); if (root) { paligoSelective.init(root); paligoSelective.schedule(); } else safeSchedule();
    } else if (pageHiddenPaused) {
      pageHiddenPaused = false; safeSchedule();
    }
  }
});

// ---- Initial kick & fallback to mitigate missing panel after refresh ----
function initialKick(reason){
  if (!userConfig.enabled) return;
  if (userConfig.manualMode) { // In manual mode just ensure panel exists with button.
    if (!panelState.panelEl) createDiagnosticsPanel();
    return;
  }
  log.debug('initialKick', reason);
  const root = detectPaligoRoot();
  if (root) { paligoSelective.init(root); paligoSelective.schedule(); return; }
  const el = getEditableElement();
  if (el) { lastValue=''; safeSchedule(); }
}
// Run once when DOM is ready (covers most refresh cases)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => initialKick('domcontentloaded')); 
} else {
  // Already ready
  setTimeout(()=>initialKick('immediate-ready'), 50);
}
// Fallback retry: if after ~2s no panel and no pending attempt, force another schedule
setTimeout(()=>{
  if (!panelState.panelEl || panelState.entries.length === 0) {
    initialKick('fallback-2s');
  }
},2000);

// Remove a single diagnostic from current panel state (optimistic UI update after Apply)
function removeDiagnosticFromPanelState(entry){
  if (!entry || !entry.diag || !entry.el) return;
  const diag = entry.diag;
  if (entry.source === 'block') {
    const arr = panelState.paligo.get(entry.el);
    if (arr) {
      const i = arr.indexOf(diag); if (i > -1) arr.splice(i,1);
      if (!arr.length) panelState.paligo.delete(entry.el);
    }
  } else if (entry.source === 'input') {
    const arr = panelState.inputs.get(entry.el);
    if (arr) {
      const i = arr.indexOf(diag); if (i > -1) arr.splice(i,1);
      if (!arr.length) panelState.inputs.delete(entry.el);
    }
  } else if (entry.source === 'contentEditable') {
    if (panelState.genericCE && panelState.genericCE.el === entry.el) {
      const arr = panelState.genericCE.diags;
      const i = arr.indexOf(diag); if (i > -1) arr.splice(i,1);
      if (!arr.length) panelState.genericCE = null;
    }
  }
}

function applyReplacement(entry){
  const d = entry.diag; if (!d || typeof d.start !== 'number' || typeof d.end !== 'number' || !d.replacement) return;
  const target = entry.el; if (!target) return;
  const repl = d.replacement;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
    const val = target.value; target.value = val.slice(0,d.start) + repl + val.slice(d.end);
    lastValue='';
    // Fire input so any upstream listeners react
    target.dispatchEvent(new Event('input',{bubbles:true}));
    // Optimistically remove this diagnostic from panel state & refresh list immediately
    removeDiagnosticFromPanelState(entry);
    schedulePanelUpdate();
    // Ensure focus stays on edited element (Apply button stole it)
    try { target.focus(); } catch {}
    // Force or schedule re-lint so new text produces updated diagnostics
    if (userConfig.manualMode) { lastValue=''; runLint({ force:true }); }
    else safeSchedule(target.value.length);
    return;
  }
  if (target.isContentEditable) {
    // Use selection cache approach
    let cache = rangeCache.get(target); const hashNow = simpleFastHash(target.textContent||'');
    if (!cache || cache.hash !== hashNow) { cache = buildRangeCache(target,6); if (!cache) return; }
    let sNode=null,sOff=0,eNode=null,eOff=0;
    for (const seg of cache.nodes){ const segEnd=seg.start+seg.len; if (!sNode && d.start>=seg.start && d.start<segEnd){ sNode=seg.node; sOff=d.start-seg.start; } if (!eNode && d.end>seg.start && d.end<=segEnd){ eNode=seg.node; eOff=d.end-seg.start; } if (sNode && eNode) break; }
    if (sNode && !eNode){ eNode=sNode; eOff=sNode.nodeValue.length; }
    if (!sNode || !eNode) return;
    const rng=document.createRange(); try { rng.setStart(sNode,sOff); rng.setEnd(eNode,eOff); } catch { return; }
    rng.deleteContents(); rng.insertNode(document.createTextNode(repl));
    lastValue='';
    // Optimistic removal & refresh
    removeDiagnosticFromPanelState(entry);
    schedulePanelUpdate();
    // Refocus edited region (restore selection after applying text)
    try { target.focus({ preventScroll:true }); } catch {}
    if (userConfig.manualMode) { lastValue=''; runLint({ force:true }); }
    else safeSchedule(target.textContent.length);
  }
}
// End of IIFE body
})();
