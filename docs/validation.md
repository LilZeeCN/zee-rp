# Validation and evidence

The repository contains the authored runtime source and all test code. Native documents and vendor software are external inputs. Default public checks do not depend on the maintainer's workspace.

| Command | Required inputs | What it verifies |
| --- | --- | --- |
| `npm test` | Node.js only | Source syntax, registry, MCP schemas, deterministic Axvg compilation, path guards, complete release packaging, baseline hashes |
| `npm run test:native` | Local blank `.rp`, local `Default.rplib` | Public recipe generation; CLI/MCP edits; recursive expressions; rich-text hyperlink/list/spacing; multi-run table; variables and duplicate pages |
| `npm run test:mcp` | Same native inputs, `npm ci` | Real SDK/stdio discovery and calls, sessions, save and rejection behavior |
| `npm run test:jobs` | macOS, local blank template | 11 mock process lifecycle assertions; no real GUI |
| `npm run test:parity` | Blank native template with page `Page 1`, record 4 | Historical 23-assertion CLI/direct-script parity and guards |
| `npm run test:historical` | Exact external fixture pack and local native runtime | Historical 225 assertions, including native summary fingerprints and specialized semantic checks |
| `npm run test:historical-mcp` | Same external fixture pack, `npm ci` | Historical 67 SDK/stdio assertions |

Missing prerequisites cause a failure, not a passing skipped check. The public native recipe is tested against RP 11.0.0.4137 macOS libraries, with English library page names. Different library/build layouts may need a new validated recipe. Native-free CI does not claim native GUI coverage.

## Environment

| Variable | Purpose |
| --- | --- |
| `AXURE_BLANK_TEMPLATE` | User-saved single-page empty native project; fallback described in README |
| `AXURE_LIBRARY_ROOT` | Directory containing the user's `Default.rplib` and other native libraries |
| `AXURE_SETTINGS_ROOT` | Local Axure `DefaultSettings` directory; historical runtime checks read its `Prototype_Files/resources/scripts/axure/expr.js` |
| `AXURE_FIXTURE_ROOT` | External historical fixture directory; defaults to ignored `test/fixtures` |
| `AXURE_PANEL_TEMPLATE` / `AXURE_PANEL_TEMPLATE_NAME` | Local panel-bearing project and panel name; default macOS `Quick Win.rp` / `Hours Panel` |
| `AXURE_WRITE_ROOT` | Optional colon-separated allowed output roots; applies through unified CLI/MCP |
| `AXURE_PROTECTED_PATHS` | Optional colon-separated forbidden input/output paths; applies through unified CLI/MCP |

The path guard has been verified on macOS/POSIX paths. Do not infer Windows drive-path sandbox correctness from clipboard support. Native tests intentionally run in a temporary directory; unset `AXURE_WRITE_ROOT` for those tests or allow the system temporary root. Direct schema probes accept a local library directory argument and do not redistribute the libraries.

## Historical fixture contract

[test/historical-fixture-contract.json](../test/historical-fixture-contract.json) records 41 native filenames, sizes, SHA-256 values, categories, and historical notes. [test/historical-snapshots.json](../test/historical-snapshots.json) stores compact fingerprints of the original full summaries, not native document text or assets. Exact fixture hashes are required; freshly generated demos do not substitute for those historical samples.

Additional inputs used by historical assertions:

- `connector-custom-anchor-writer-roundtrip-20261012.rp`
- `connector-nested-panel-writer-positioned-gui-roundtrip-20261012.rp`
- `native-widgets-tree-trigger.rp`
- `axure-rp11-blank.rp` (the user-saved blank template)

These names refer to external historical documents. The source assertions explain their expected objects/values. Those binaries are not distributed; users without them can run the public native recipe and tests, but cannot reproduce the historical 225/67 result exactly. This is an explicit evidence limitation. No internal file paths are required by the public code.

```sh
export AXURE_BLANK_TEMPLATE="/absolute/path/blank.rp"
export AXURE_LIBRARY_ROOT="/absolute/path/DefaultSettings/Libraries"
export AXURE_SETTINGS_ROOT="/absolute/path/DefaultSettings"
npm test
npm run test:native
npm run test:mcp
# Optional exact historical replay:
export AXURE_FIXTURE_ROOT="/absolute/path/external-fixture-pack"
npm run test:historical
npm run test:historical-mcp
```

## Evidence levels

1. Construction: a command wrote output.
2. Offline structure/semantics: records parse and required fields/references/values match.
3. Native load: Axure opens the candidate.
4. Preview behavior: observed interactions produce the expected outcome.
5. GUI editing and save/reopen: edit the intended native object, save, close, reopen, and verify it remains.

Each level is reported separately. The 2026-10-12 implementation sync and this release's automated tests are offline checks. Earlier samples have specific native acceptance records described in [historical capability notes](historical-capabilities.md); those records are historical and their raw evidence is not bundled. See [release-evidence.json](release-evidence.json) for the actual commands/results of this release.

## Packaging

`node scripts/pack-release.mjs -o <new-directory>` copies the complete public source, tests, docs, example recipes, and authored assets without modifying their content. Native files, fixture directories, symlinks, and dependency directories are excluded. The result includes a SHA-256 manifest and can run the same public checks. `npm pack --dry-run` must also contain zero `.rp`/`.rplib` or fixture payloads.
