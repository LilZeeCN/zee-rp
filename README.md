# zee-rp

[简体中文](README.zh-CN.md) · [Command reference](references/commands-generated.md) · [Validation](docs/validation.md)

Independent, MIT-licensed tools for reading and editing Axure RP 11 `.rp` prototypes: a binary codec, native-object cloning, interactions, rich text, tables, and an optional MCP server. **31 CLI commands and 43 MCP tools.** Node.js 18 or newer; native acceptance recorded on macOS / Axure RP 11.0.0.4137. Other builds and platforms need separate validation.

The implementation, schemas, test runners, test contracts/fingerprints, documentation generator, release packer, and reproducible example recipes are included. Native `.rp`/`.rplib` inputs, Axure application/runtime files, private session data, and internal scratch work are excluded. Supply native assets from your own installation. This is a toolkit for supported prototype operations; it does not guarantee arbitrary documents or interactions.

![Reference layout rendered from the public specification](assets/demo-layout.svg)

This image is a deterministic **reference rendering**, not an Axure screenshot or evidence of native acceptance. Its source is [dashboard-example.spec.json](assets/dashboard-example.spec.json); regenerate it with `node examples/render-layout.mjs assets/dashboard-example.spec.json assets/demo-layout.svg`.

## Setup

```sh
git clone https://github.com/LilZeeCN/zee-rp.git
cd zee-rp
npm ci                     # needed for the optional MCP server
node bin/axure.mjs --help
npm test                   # works without Axure or a native template
```

In your own Axure RP 11, create a single-page blank project named `Page 1`, save it, and point to that file. The template is validated as genuinely blank before copying.

```sh
export AXURE_BLANK_TEMPLATE="/absolute/path/blank.rp"
# Optional on macOS; required when your installation is elsewhere:
export AXURE_LIBRARY_ROOT="/absolute/path/DefaultSettings/Libraries"
# Restrict writes if desired. Create this directory first.
export AXURE_WRITE_ROOT="/absolute/path/outputs"
```

If no template path is set, the fallback is `~/Library/Application Support/zee-rp/templates/axure-rp11-blank.rp`. `.rp` writers use new output paths and reject existing files. Path restrictions belong to the unified CLI/MCP; direct library calls do not provide the same wrapper guards. See [environment variables](docs/validation.md#environment).

## Working examples

Run from the repository root. Create a fresh destination under any configured write root. The recipe uses `Default.rplib` from your local installation; it creates named widgets and a classic table without relying on private research fixtures.

```sh
node examples/build-native-demo.mjs /absolute/path/outputs/demo
node bin/axure.mjs rp-read /absolute/path/outputs/demo/5-widget.rp --json
node bin/axure.mjs set-widget-text /absolute/path/outputs/demo/5-widget.rp /absolute/path/outputs/text.rp "Page 1" "SubmitButton" "Confirm & Proceed"
node bin/axure.mjs set-widget-richtext /absolute/path/outputs/demo/5-widget.rp /absolute/path/outputs/rich.rp examples/richtext.json
node bin/axure.mjs set-native-table /absolute/path/outputs/demo/table.rp /absolute/path/outputs/table.rp examples/table.json
node bin/axure.mjs create-global-variable /absolute/path/outputs/demo/5-widget.rp /absolute/path/outputs/variable.rp Counter --default-value "7"
node bin/axure.mjs add-interaction /absolute/path/outputs/demo/5-widget.rp /absolute/path/outputs/click.rp SubmitButton --on-page "Page 1" --event OnClick --action wait ms=100
node bin/axure.mjs duplicate-page /absolute/path/outputs/demo/5-widget.rp /absolute/path/outputs/pages.rp "Page 1" "Page Copy"
```

Rich text takes a JSON **file**, with `paragraphs[].runs[]`, run `style.size`, and run `link` alongside `style`. If your blank page has a different name, update `examples/richtext.json` in a new copy and the page arguments. For a panel that already exists:

```sh
node bin/axure.mjs add-interaction source.rp new.rp OpenMenuBtn --on-page "Home" --event OnClick --action set-panel-state target=MenuPanel state=Expanded
```

`--on-page` selects the widget's page; `--page` instead selects a page-level event target. Action names use the command reference's spelling. To compile the public layout:

```sh
node bin/axure.mjs axvg build assets/dashboard-example.spec.json -o /absolute/path/outputs/demo.axvg.json
# macOS/Windows clipboard route; requires a running Axure canvas:
node bin/axure.mjs axvg paste /absolute/path/outputs/demo.axvg.json
```

## MCP

```json
{
  "mcpServers": {
    "zee-rp": {
      "command": "node",
      "args": ["/absolute/path/to/zee-rp/bin/mcp.mjs"],
      "env": {
        "AXURE_BLANK_TEMPLATE": "/absolute/path/blank.rp",
        "AXURE_WRITE_ROOT": "/absolute/path/outputs"
      }
    }
  }
}
```

There are 31 command tools, eight session tools, and four GUI/job tools. Use the client's tool discovery for exact schemas. Most command tools accept raw `args`; selected tools also support named fields. The session flow is `axure_open` → `locate` / `inspect` → `edit_text` → `verify` → `axure_save`. Raw command calls with `session:true` can use the current chain. Native GUI jobs require macOS, Axure, and Accessibility permission.

For rich text through MCP, call `axure_open` with `{"path":"/absolute/source.rp"}`, then `edit_text` with `{"target":{"name":"StatusBanner"},"richRuns":[{"list":true,"lineSpacing":72,"runs":[{"text":"Documentation","link":{"url":"https://example.com","window":"new"}}]}]}`. `create_global_variable` supports `source`, `output`, `name`, and `defaultValue`, or a session call without the source/output pair.

## Tests and releases

- `npm test`: public source/contract/packaging checks; no Axure required.
- `npm run test:native`: generates new native examples from your local template/library, then checks actual CLI/MCP writes and semantic fields. No private fixture pack required.
- `npm run test:mcp`: real SDK/stdio transport and generated native examples; run `npm ci` first.
- `npm run test:jobs`: 11 mock process lifecycle checks; requires macOS and a local blank template, but does not operate the GUI.
- `npm run test:parity`: the 23-check CLI/direct-script comparison, using your local blank template.
- `npm run test:historical` and `test:historical-mcp`: published historical runners; require the exact external fixture pack described in [validation](docs/validation.md). Historical 225/67 results are not the result of `npm test`.

[Release evidence](docs/release-evidence.json) separates current offline results from historical native acceptance. Parse success, loading, preview behavior, and GUI edit/save/reopen are independent checks. Added offline features are not automatically GUI-verified.

```sh
node scripts/gen-capabilities.mjs -o /absolute/path/new-commands.md
node scripts/pack-release.mjs -o /absolute/path/new-release-directory
```

The packer preserves all public scripts/tests/docs, excludes native fixtures and symlinks, and writes SHA-256 fingerprints. See [CONTRIBUTING](CONTRIBUTING.md), [capability limits](references/capabilities.md), and [MIT license](LICENSE).

zee-rp is an independent project and is not affiliated with, sponsored by, or endorsed by Axure Software Solutions, Inc. Axure RP and related marks belong to their respective owners. The MIT license covers this repository's authored code and documentation; it does not license the Axure application, its libraries, runtime, or third-party assets.
