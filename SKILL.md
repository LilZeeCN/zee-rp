---
name: zee-rp
description: Reconstruct screenshots as editable Axure layouts, compile RP/1 specifications into native prototypes, and inspect or edit RP9/RP11 files using CLI or MCP.
---

# zee-rp

Read [README](README.zh-CN.md), [capabilities](references/capabilities.md) and [verification](docs/verification.md). Run commands from this repository with its Python environment activated.

- Screenshots: `node scripts/trace.mjs draft <image> -o <new-dir> --scale <physical/logical ratio> --axvg <new.axvg.json>`. Follow [screenshot-workflow.md](references/screenshot-workflow.md). Inspect OCR and image usage. Clipboard JSON becomes `.rp` only after Axure paste and save.
- New prototypes: `node scripts/proto.mjs check --spec <source>` then `generate --spec <source> --out-dir <new-dir> --out-rp <new.rp>`. See [rp-language.md](references/rp-language.md). Provide the matching local blank template.
- Existing `.rp`: inspect with `node bin/axure.mjs rp-read <file> --json`, then select a supported writer from `--help`. Preserve the input and write new outputs.
- Rename: RP/1 node `name` becomes the native OUTLINE label. For an existing file, use `node bin/axure.mjs name-widget <source.rp> <new.rp> --name <oldName> --to <newName> [--page <page>]`. MCP sessions support `rename_widget({target: {name: "old"}, name: "new"})` or an `edits` array; ambiguous names return candidates, then use `record` + `id`. Renaming preserves object identities and interactions.
- HTML: [html-workflow.md](references/html-workflow.md) is a browser-assisted static reconstruction workflow; it does not automatically transfer website logic.

Never overwrite a user's original prototype. `AXURE_PROTECTED_PATHS` can configure protected files; `AXURE_WRITE_ROOT` can limit writes. Native assets come from the user's installation.

Report structure, Axure load, preview, GUI edits, and save/close/reopen separately. Local raster comparisons are not native previews; simulation is not observed native behavior.
