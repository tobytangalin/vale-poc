#!/usr/bin/env node
/*
 compare-wasm.mjs
 Goal: Compare diagnostics between Vale CLI and vale-native WASM build for sample fixtures.

 Prerequisites:
 1. Vale CLI installed and on PATH (vale --version works).
 2. Build vale-native WASM (wasm-pack) and copy pkg/ into chrome-extension/.
 3. Provide sample texts under test/fixtures/*.txt

 Usage:
   node scripts/compare-wasm.mjs

 Output:
   Table diff of rule/message mismatches and count summary.
*/
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { spawnSync } from 'child_process';
import { normalizeDiagnostics } from './diagnostic-normalizer.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const fixturesDir = path.join(repoRoot, 'test', 'fixtures');
const extDir = path.join(repoRoot, 'chrome-extension');
const wasmJs = path.join(extDir, 'pkg', 'vale_native.js');
const wasmBin = path.join(extDir, 'pkg', 'vale_native_bg.wasm');
const args = process.argv.slice(2);
const useMock = args.includes('--mock');

if (!fs.existsSync(fixturesDir)) {
  console.error('No fixtures directory at', fixturesDir);
  process.exit(1);
}
let wasmModule = null;
let wasmLint = null;
if (!fs.existsSync(wasmJs) || !fs.existsSync(wasmBin)) {
  if (useMock) {
    console.warn('WASM pkg missing; running in --mock mode using substitution fallback rules.');
  } else {
    console.error('Missing WASM build (pkg/). Build vale-native first or run with --mock.');
    process.exit(1);
  }
}

const fixtures = fs.readdirSync(fixturesDir).filter(f => f.endsWith('.txt'));
if (!fixtures.length) {
  console.error('No *.txt fixtures to test.');
  process.exit(1);
}

// Load rule YAMLs (raw) for WASM side
const sitecoreRulesDir = path.join(repoRoot, '.vale', 'styles', 'Sitecore');
const ruleFiles = fs.readdirSync(sitecoreRulesDir).filter(f => f.endsWith('.yml'));
const ruleMap = {};
for (const f of ruleFiles) ruleMap['Sitecore/' + f] = fs.readFileSync(path.join(sitecoreRulesDir, f), 'utf8');

if (!useMock && fs.existsSync(wasmJs) && fs.existsSync(wasmBin)) {
  wasmModule = await import(pathToFileURL(wasmJs).href).catch(e => { console.error('Failed import WASM JS', e); process.exit(1); });
  if (typeof wasmModule.default === 'function') {
    await wasmModule.default(pathToFileURL(wasmBin).href);
  }
  wasmLint = wasmModule.lint_text || wasmModule.lint;
  if (!wasmLint) {
    console.error('No lint function exported by WASM module.');
    process.exit(1);
  }
}

let mockRules = null;
let findDiagnostics = null;
if (useMock) {
  const rulesLoaderPath = path.join(extDir, 'rules-loader.js');
  if (fs.existsSync(rulesLoaderPath)) {
    const rl = await import(pathToFileURL(rulesLoaderPath).href);
    mockRules = rl.loadYamlRules(Object.values(ruleMap).join('\n---\n'));
    findDiagnostics = rl.findDiagnostics;
  } else {
    console.error('Cannot locate rules-loader.js for mock mode.');
    process.exit(1);
  }
}

function runCliVale(text) {
  // Write temp file
  const tmpFile = path.join(repoRoot, '.tmp_vale_compare.txt');
  fs.writeFileSync(tmpFile, text, 'utf8');
  const res = spawnSync('vale', ['--output=JSON', tmpFile], { encoding: 'utf8' });
  if (res.error) return { error: res.error.message };
  let parsed; try { parsed = JSON.parse(res.stdout); } catch { parsed = { error: 'JSON parse failed', raw: res.stdout }; }
  return parsed;
}

const results = [];
for (const fixture of fixtures) {
  const text = fs.readFileSync(path.join(fixturesDir, fixture), 'utf8');
  const cli = runCliVale(text);
  let cliDiagsRaw = [];
  if (Array.isArray(cli)) cliDiagsRaw = cli; else if (cli[fixture]) cliDiagsRaw = cli[fixture]; else if (cli.diagnostics) cliDiagsRaw = cli.diagnostics;
  const cliNorm = normalizeDiagnostics(cliDiagsRaw, text);
  let wasmRaw;
  if (useMock) {
    const parsedRules = await mockRules;
    wasmRaw = findDiagnostics(text, parsedRules);
  } else {
    try {
      const out = wasmLint(text, JSON.stringify({ files: ruleMap }));
      wasmRaw = typeof out === 'string' ? JSON.parse(out) : out;
    } catch (e) {
      wasmRaw = { error: e.message };
    }
  }
  const wasmNorm = normalizeDiagnostics(wasmRaw, text);
  results.push({ fixture, cli: cliNorm, wasm: wasmNorm });
}

// Diff
function signature(d) { return `${d.rule}|${d.start}|${d.end}|${d.message}`; }

let totalCli = 0, totalWasm = 0, mismatch = 0;
for (const r of results) {
  totalCli += r.cli.length; totalWasm += r.wasm.length;
  const cliSet = new Set(r.cli.map(signature));
  const wasmSet = new Set(r.wasm.map(signature));
  for (const s of cliSet) if (!wasmSet.has(s)) mismatch++;
  for (const s of wasmSet) if (!cliSet.has(s)) mismatch++;
}

console.log('Fixtures:', fixtures.length);
console.log('CLI diagnostics:', totalCli);
console.log('WASM diagnostics:', totalWasm);
console.log('Mismatched signatures:', mismatch);

if (mismatch) {
  console.log('\nDetailed per-fixture diff:');
  for (const r of results) {
    const cliSet = new Set(r.cli.map(signature));
    const wasmSet = new Set(r.wasm.map(signature));
    const missingInWasm = [...cliSet].filter(s => !wasmSet.has(s));
    const extraInWasm = [...wasmSet].filter(s => !cliSet.has(s));
    if (missingInWasm.length || extraInWasm.length) {
      console.log(`\n[${r.fixture}]`);
      if (missingInWasm.length) console.log('  - Missing in WASM:', missingInWasm.slice(0,10));
      if (extraInWasm.length) console.log('  + Extra in WASM:', extraInWasm.slice(0,10));
    }
  }
  process.exitCode = 2;
}
