const defaults = { enabled: true, manualMode: false, debounceBase: 400, sizeFactor: 300, severity: { error: true, warning: true, info: false } };
const LIMITS = { debounceBase: { min:150, max:2000 }, sizeFactor: { min:0, max:1000 } };

function load() {
  chrome.storage.sync.get(defaults, cfg => {
    document.getElementById('enabled').checked = cfg.enabled;
  document.getElementById('manualMode').checked = cfg.manualMode;
  document.getElementById('debounceBase').value = cfg.debounceBase;
    document.getElementById('sizeFactor').value = cfg.sizeFactor;
    document.getElementById('debounceValue').textContent = cfg.debounceBase;
    document.getElementById('sizeFactorVal').textContent = cfg.sizeFactor;
    const sev = cfg.severity || defaults.severity;
    document.getElementById('sevError').checked = sev.error !== false; // default true
    document.getElementById('sevWarning').checked = sev.warning !== false; // default true
    document.getElementById('sevInfo').checked = !!sev.info; // default false
  });
}
function save(e){
  e.preventDefault();
  let debounceBase = +document.getElementById('debounceBase').value;
  let sizeFactor = +document.getElementById('sizeFactor').value;
  debounceBase = Math.min(LIMITS.debounceBase.max, Math.max(LIMITS.debounceBase.min, debounceBase));
  sizeFactor = Math.min(LIMITS.sizeFactor.max, Math.max(LIMITS.sizeFactor.min, sizeFactor));
  const cfg = {
    enabled: document.getElementById('enabled').checked,
  debounceBase,
  manualMode: document.getElementById('manualMode').checked,
    sizeFactor,
    severity: {
      error: document.getElementById('sevError').checked,
      warning: document.getElementById('sevWarning').checked,
      info: document.getElementById('sevInfo').checked
    }
  };
  chrome.storage.sync.set(cfg, () => {
    const st = document.getElementById('status');
    st.textContent = 'Saved';
    setTimeout(()=> st.textContent='', 1400);
  });
}
document.getElementById('debounceBase').addEventListener('input', e => document.getElementById('debounceValue').textContent = e.target.value);
document.getElementById('sizeFactor').addEventListener('input', e => document.getElementById('sizeFactorVal').textContent = e.target.value);
document.getElementById('opts').addEventListener('submit', save);
load();