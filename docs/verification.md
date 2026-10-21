# Release verification

Version 0.2.0 ships screenshot reconstruction, RP/1, native-file tools and verification sources together. [release-checks.json](release-checks.json) records checks actually executed on this delivery. Historical research totals are not substituted for release results.

Public Node checks need no Axure. Synthetic JSON fixtures are included. Native generation reads the user's local blank template and libraries. Oracle checks load local RP9 `sto.js` and `expr.js`; `AXURE_RUNTIME_SCRIPTS` can select that directory. No official inputs are bundled.

The screenshot demonstration is original artwork from `examples/generate-assets.py`. Its local image difference measures the software renderer unless a separate result explicitly identifies native-preview evidence. GUI load, editing, save/close/reopen and behavior need separate proof.

The 2026-10-21 research correction fixed demonstrated selection, shared master navigation, adaptive overrides and false-positive GUI gates. It did not retroactively validate all 90 historical trials. The historical first-pass claim remains 83/90 and external human trials remain zero. These are context, not release-check totals.

Known limits: macOS-specific screenshot OCR/GUI automation; recent native RP/1 behavior on specific RP9 samples; bounded master/adaptive coverage; static screenshots do not recover hidden application logic.

## Checked examples

The original screenshot produced 63 text/geometry objects and no image objects in its specification; its local-render MAE was 3.50/255. Clipboard expansion and the Axure page result contain additional native objects. The saved RP9 file had 67 widgets and zero structural problems. A separate RP/1 counter had 6 widgets and 2 interactions. Both samples were saved, closed and reopened in RP9; these checks do not claim native preview or GUI edits.
