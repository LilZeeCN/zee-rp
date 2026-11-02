# Release verification

Version 0.2.1 adds RP/1 authoring improvements, diagnostic fixes and existing-native-style maintenance. [release-checks-v0.2.1.json](release-checks-v0.2.1.json) records this delivery's checks; [release-checks.json](release-checks.json) retains the previous 0.2.0 evidence. Historical research totals are not substituted for release results.

Public Node checks need no Axure. Synthetic JSON fixtures are included. Native generation reads the user's local blank template and libraries. Oracle checks load local RP9 `sto.js` and `expr.js`; `AXURE_RUNTIME_SCRIPTS` can select that directory. No official inputs are bundled.

The screenshot demonstration is original artwork from `examples/generate-assets.py`. Its local image difference measures the software renderer unless a separate result explicitly identifies native-preview evidence. GUI load, editing, save/close/reopen and behavior need separate proof.

The 2026-10-21 research correction fixed demonstrated selection, shared master navigation, adaptive overrides and false-positive GUI gates. It did not retroactively validate all 90 historical trials. The historical first-pass claim remains 83/90 and external human trials remain zero. These are context, not release-check totals.

Known limits: macOS-specific screenshot OCR/GUI automation; recent native RP/1 behavior on specific RP9 samples; bounded master/adaptive coverage; static screenshots do not recover hidden application logic.

## Custom styles — 2026-10-25 (0.2.1)

GitHub #1/#2 are addressed with existing-native-style listing, cascading rename and batch rebinding. Global CustomStyles definitions must be created in Axure first; the reported signature theory has not been independently established. No global style creation API is provided. Styles containing object/package references are explicitly rejected.

Fresh checks: core 17/17, CLI parity 23/23, synthetic custom-style groups 8/8, prior report checks Python 69/69 and MCP 36/36. A fresh stdio client successfully invoked all three new tools on a locally generated native RP9 sample. RP9 loaded the rebound/renamed single-widget sample, showed `IssueStyle_B` without an override asterisk, saved it, closed the document window and reopened it with the same style and geometry and zero structural problems. A control changing only the global definition retained stale MatchInfo/StyleCache names in the file, but RP9 also displayed the current style without an asterisk: the reporter's asterisk symptom was not reproduced on this host/sample. The name-consistency defect is covered independently by structural assertions. This does not establish GUI coverage for masters, panel states, RPLIB or RP11. The first automatic roundtrip was cancelled after a host-focus stall; subsequent CUA actions provide the actual save/reopen evidence.

## Previous release samples

The original screenshot produced 63 text/geometry objects and no image objects in its specification; its local-render MAE was 3.50/255. Clipboard expansion and the Axure page result contain additional native objects. The saved RP9 file had 67 widgets and zero structural problems. A separate RP/1 counter had 6 widgets and 2 interactions. Both samples were saved, closed and reopened in RP9; these checks do not claim native preview or GUI edits.

## MCP generation update — 2026-10-22 (included in 0.2.1)

The new [generate_prototype entry](../references/mcp-prototype.md) was tested through an actual stdio MCP client: 8/8 checks cover three-page generation, twelve-page assembly, shared components, cross-page data actions, subsequent MCP editing, diagnostic context, strict audit and output protection. The three-page sample contains 34 widgets, 7/7 materialized events and 13 actions, with zero unparseable records, dangling references or structural problems.

Separate macOS Axure RP9 checks opened the MCP-generated file, edited a heading and an interactive button in the GUI, saved, closed and reopened it, then previewed the edited file. Both subject branches carried the selected subject and typed study plan from list to detail to result. Twelve-page coverage is structural and does not claim twelve-page GUI or runtime verification.

Bundled language examples include compact functional benchmarks and product layouts. Layout warnings depend on the specification; default generation reports them and `strictAudit: true` blocks delivery when warnings remain. The current multi-page generation suite covers accepted examples and deliberate strict-audit failures. The historical results of 0.2.0 remain in its separate release record.
