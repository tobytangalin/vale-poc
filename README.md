# Vale Linting for Sitecore Docs & Browser Prototype

This repository contains:

1. A `.vale` folder with custom styles for linting documentation using [Vale](https://vale.sh/).
2. A prototype Chrome (Manifest V3) extension (`chrome-extension/`) that applies a simplified, client‑side version of the substitution rules to editable text on any page. This is a stepping stone toward embedding `vale-native` compiled to WebAssembly.

## Prerequisites

- [Vale](https://vale.sh/) must be installed on your system.

## Installation

Refer their docs to [install Vale](https://vale.sh/docs/install) on your operating system.

Confirm installation by running the following command from the command line:

```bash
vale --version
```

## Configuration

1. Clone this repository or copy the `.vale.ini` and `.vale/` folder into your documentation project.

1. Ensure your `.vale.ini` file references the correct styles path.

1. You can customise the `.vale.ini` file to enable or disable specific styles.

## Usage (CLI)

Vale automatically lints documentation in the same folder as the `.vale` and `.vale.ini` files, but you can also use it from the command line to target specific files or folders:

```bash
# Specific file
vale path/to/file.md

# Entire folder
vale docs/

## Chrome Extension Prototype

Path: `chrome-extension/`

What it does (current state):

- Loads `write-simply.yml` and extracts the `swap:` substitution pairs.
- Scans the active editable element (input, textarea, or contentEditable) after you pause typing.
- Highlights matched phrases and shows a tooltip with the suggested replacement.
- Click a highlighted phrase (contentEditable) to apply the replacement (quick‑fix).
- Inputs/Textareas: overlay draws clickable highlighted phrases; click to replace. Undo last replacements with `Ctrl+Alt+Z`.

What it does NOT yet do:

- Run the full Vale rule engine.
- Support all rule types (only simple substitutions are prototyped).
- Persist settings or allow enabling/disabling rules via UI.

### Install Locally

1. Open Chrome -> Extensions -> Enable Developer Mode.
2. Click "Load unpacked" and select the `chrome-extension/` folder.
3. Focus a text field or a rich text editor and type any phrase from the YAML (e.g., "utilize"). It should underline the phrase and show the preferred alternative.
4. Open `chrome-extension/test-harness.html` in a tab (via file:// or by dragging into Chrome) for a consolidated test page with contentEditable, textarea, and input examples.

### Build (Generate Dist Package)

Optional build script bundles all rule YAML files and produces a `dist/extension` folder with an expanded manifest enumerating each rule file under `web_accessible_resources`.

Steps (PowerShell):

```powershell
# Install dependencies (none currently other than Node itself)
cd "C:\Git Repos\vale-poc"
npm run build

# Output: dist/extension
# To load built version:
# Chrome -> Load unpacked -> select dist/extension

# (Optional) create zip skeleton command printed after build; or run:
Compress-Archive -Path dist/extension/* -DestinationPath extension-package.zip -Force
```

#### Restrict to a Specific Domain

To inject only on `https://sitecore.paligoapp.com/` (and its paths):

```powershell
npm run build -- --domain=https://sitecore.paligoapp.com
```

This rewrites `content_scripts[*].matches` and `web_accessible_resources[*].matches` to `https://sitecore.paligoapp.com/*`.

For multiple domains, run separate builds or adapt the script (currently single `--domain=` supported). Future enhancement: accept comma‑separated list.

During build:

- Copies `chrome-extension/` sources (excluding its `rules` directory) into `dist/extension`.
- Copies all `.vale/styles/Sitecore/*.yml` rule files into `dist/extension/rules/Sitecore`.
- Generates `rules-index.js` listing all rules.
- Rewrites `manifest.json` in dist to include each rule file plus any `pkg/*.wasm` present.

For development without running the build, only `write-simply.yml` is accessible; full multi-rule operation requires the build output.

### Diagnostic Parity (WASM vs CLI)

After building the WASM module (copy `pkg/` into `chrome-extension/`), you can compare diagnostics produced by the CLI and the WASM build on bundled sample fixtures:

```powershell
npm run compare:wasm
```

What it does:

- Loads all Sitecore rule YAML files.
- Imports the WASM module (`pkg/vale_native.js`).
- Runs Vale CLI (requires `vale` on PATH) on `test/fixtures/*.txt`.
- Normalizes both outputs to a shared schema.
- Reports counts and signature mismatches (rule|start|end|message).

Exit code:

- 0: Perfect parity (signatures match).
- 2: Differences detected (review console diff output).

Add more fixtures by placing `.txt` files under `test/fixtures/` and rerun the script.

If you don't yet have the WASM build, run a dry-run mock mode (uses the JS substitution fallback) to verify the diff workflow:

```powershell
npm run compare:wasm:mock
```

This lets you test the harness before integrating the real engine.

### Building the vale-native WASM Module

Prerequisites:

1. Rust toolchain (stable) + wasm-pack installed:
	```powershell
	cargo install wasm-pack
	```
2. Clone (or have locally) the `vale-native` (Rust) source that exposes a `lint_text` (preferred) or `lint` function.

Build steps (example):

```powershell
cd path\to\vale-native
wasm-pack build --target web --release
```

Copy the generated `pkg` folder into `chrome-extension/` so you have:

```
chrome-extension/pkg/vale_native.js
chrome-extension/pkg/vale_native_bg.wasm
```

Rebuild the extension to include the WASM in `web_accessible_resources`:

```powershell
npm run build
```

Then run the parity comparison:

```powershell
npm run compare:wasm
```

If your Rust API name differs, adapt `vale-native-bridge.js` (search for `lint_text` heuristic) to call the exported function.

### Moving to `vale-native` (WASM)

To integrate the actual engine:

1. Clone `https://github.com/errata-ai/vale-native` (outside this repo).
2. Ensure Rust toolchain installed and add the WASM target: `rustup target add wasm32-unknown-unknown`.
3. Build with wasm-pack (install first if needed):
	- `cargo install wasm-pack`
	- From the `vale-native` directory run: `wasm-pack build --target web --release`
4. Copy the generated `pkg/` directory (e.g. containing `vale_native.js` & `vale_native_bg.wasm`) into this repo's `chrome-extension/` folder (so path becomes `chrome-extension/pkg/...`).
5. Reload the extension. The background script now attempts to initialize the WASM engine via `vale-native-bridge.js`.
6. On success, linting will switch to the real engine (diagnostic payload shape may differ; adapt mapper if needed).
7. If WASM init fails (missing files, API mismatch) the extension logs a warning and falls back silently to the simple substitution highlighter.

Bridge assumptions (adjust once actual API is confirmed):

- Exposed function name: `lint_text(text, rulesJson)` returning JSON string or array.
- We currently convert the substitution list into `{ substitutions: [{ from, to }] }` as a placeholder. Replace this with the structure `vale-native` expects.
- Update `vale-native-bridge.js` if the crate or exported symbol names differ.

Troubleshooting WASM:

- Open Extensions page -> service worker console; look for `[vale-native-bridge]` logs.
- Ensure `manifest.json` includes the WASM file under `web_accessible_resources` (already configured).
- If you see MIME errors, Chrome sometimes needs explicit headers; locally (unpacked) this should be fine.


### Suggested Next Steps

- Add options page to toggle specific rules.
- Add batching/diffing to only re-lint changed segments for performance.
- Persist last diagnostics to allow quick re‑application after DOM mutations.
- Integrate full `vale-native` once WASM API is ready.

### Development Notes

The current JS YAML parsing is purposely minimal—only `swap:` keys under 2+ spaces indentation are read. For robustness, replace with a real YAML parser (e.g. `yaml` npm module) when adding a build step.

```