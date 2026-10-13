# Capability boundaries

Updated 2026-10-13 for zee-rp 0.1.1. **31 CLI commands / 43 MCP tools.** The source reflects the 2026-10-12 implementation, plus the public CLI/MCP and packaging fixes in the changelog. All capabilities are scoped to supported inputs; no arbitrary-document guarantee is implied.

| Area | Public implementation | Evidence and limits |
| --- | --- | --- |
| Records, payloads and reading | `rp-records`, `parse-payload`, `rp-read` | Compressed native RP 11 inputs; uncompressed manifest writing is unsupported. Parse/three-zero health is not native acceptance. |
| Blank projects and pages | `blank-template`, `create-blank-project`, `create-blank-page`, `duplicate-page` | User-provided real blank template; new page/widget/container identities are remapped. Specific historical GUI samples exist. |
| Native widgets and containers | `clone-closure`, `clone-library-widget`, `clone-library-page-content`, panel/state writers | Clone genuine local templates. Closure/scope checks deliberately reject unsupported external references and actions. |
| Masters | `create-master`, `place-master`, `set-master-overrides` | Existing native template-based definitions/instances; recent closure fixes are offline-validated. Overrides cover supported Text/Image values, not arbitrary styles/defaults. |
| Expressions and interactions | `ix-actions`, `add-interaction`, `remove-interaction`, `expr-schema` | Recursive binary expressions and a registered FCall contract. Unknown functions, Concat FCall, independent refresh-repeater, and unsupported candidate-set literals are rejected. Different functions/targets need native behavior checks. |
| Variables | `create-global-variable`, `set-global-variable` action | Named variable/default writes and GUID lookup. New writer is offline-validated; it is exposed in CLI/MCP. |
| Rich text and tables | `set-widget-richtext`, `set-native-table`, `encodeStyleEntry` | Multi-run styles, supported links, line spacing, native list levels, wrapping/trimming; table multi-run cells. Numbered lists and true native merged cells are not provided. Visual merges use overlays. Latest parameters have offline evidence only. |
| Form controls and images | text writers, `set-listbox-options`, library closure cloning | Supported native widgets/assets from the user's documents; no guarantee for every image format/state/container. |
| Connectors | `clone-native-connector`, `set-connector-anchors` | Supported same-diagram/native custom-point/nested-source closure. Cross-state/scope constraints apply. Recent custom-anchor support is offline-validated. |
| Adaptive views and repeaters | `add-adaptive-view`, repeater actions and clone closure | Specific historical sample acceptance; scoped datasets and single-column expression forms. No universal multi-column rule builder. |
| Static canvas | `axvg` | Public specification compiler; native paste requires a running Axure canvas. Reference SVG is a separate authored preview. |
| MCP sessions and jobs | `mcp-tools`, `jobs`, `gui-roundtrip.swift` | CLI tools + sessions + jobs. Mock job tests verify orchestration, not actual GUI behavior. Native GUI jobs require macOS and Accessibility permission. |

[Generated commands](commands-generated.md) lists actual CLI arguments and all production libraries. [Validation](../docs/validation.md) documents reproducible public checks, native inputs, historical fingerprints, and the independent evidence levels. [Historical detailed capability notes](../docs/historical-capabilities.md) preserve the earlier sample-specific findings; raw internal evidence is not part of this distribution.

Neither the historical 225/67 assertions nor the default test count is a feature coverage percentage. New offline checks do not close outstanding native loading, preview, or GUI edit/save/reopen work.
