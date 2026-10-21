# zee-rp

**Turn screenshots and structured descriptions into editable Axure prototypes. Read and modify native `.rp` files through CLI or MCP.**

[简体中文](README.zh-CN.md) · [Screenshot workflow](references/screenshot-workflow.md) · [RP/1 language](references/rp-language.md) · [Capabilities](references/capabilities.md)

![Original screenshot demo](examples/screenshot/source.png)

## What ships

- **Screenshot reconstruction:** OCR, layout and shape detection, editable text, chart geometry, layered images, automatic drafts, text corrections and visual differences.
- **RP/1:** JSON / text syntax for layouts, native inputs, panels, repeaters, data, expressions, interactions, rules and bounded master/adaptive-view support.
- **Native file tools:** inspect and edit text, rich text, pages, interactions, tables, connectors, panels, repeaters and masters, with version-aware RP9/RP11 serialization.
- **Verification:** reference simulation, expression checks against a locally installed Axure runtime, native-preview replay, counterexample reduction and GUI evidence checks.
- Complete Node, Python and Swift sources, CLI, MCP, Agent Skill, examples and tests.

This is an independent experimental project, unaffiliated with Axure. Recent RP/1 native behavior is validated on specific macOS + Axure RP9 samples, not every feature/version/platform. See [verification](docs/verification.md).

## Install

Node.js 18+ and Python 3.10+. Screenshot OCR needs macOS Vision and a Swift compiler. Native generation needs your local Axure installation and a blank project saved by the matching version.

```sh
git clone https://github.com/LilZeeCN/zee-rp.git
cd zee-rp
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
npm ci
```

Keep the Python environment activated when calling Node wrappers: they launch `python3` from `PATH`. The native Node file engine has no required npm runtime dependency; MCP uses the optional SDK. Visual features require the Python dependencies above.

## Screenshot to editable layout

```sh
node scripts/trace.mjs draft examples/screenshot/source.png -o outputs/screenshot --scale 1 --axvg outputs/screenshot/page.axvg.json
```

This generates a layout specification, clipboard JSON and comparison images. To create a real `.rp`, paste into Axure and save. For RP9, open a new working project and run:

```sh
python3 tools/rp9_place.py /absolute/path/to/working-project.rp --axvg outputs/screenshot/page.axvg.json
```

The GUI helper clears the specified working project's current page before placing the layout. Use a new project. In RP11, run `node scripts/axvg.mjs paste outputs/screenshot/page.axvg.json --version 11` and save in Axure.

Supported text and geometry are editable native objects. Photos, complex artwork and some icons remain independent image objects. A screenshot does not reveal the original application's business logic. [Workflow and metrics](references/screenshot-workflow.md).

## RP/1 to native `.rp`

Save your own blank single-page project in RP9, then:

```sh
export AXURE_BLANK_TEMPLATE_RP9=/absolute/path/to/own-rp9-blank.rp
node scripts/proto.mjs check --spec examples/rp-language/counter.json
node scripts/proto.mjs generate --spec examples/rp-language/counter.json --out-dir outputs/counter --out-rp outputs/counter/counter.rp
```

A larger data example is `examples/rp-language/runtime-inventory.json`. Use new output names. Native templates, widget libraries and Axure JavaScript are read from your own installation and never bundled.

## CLI, MCP and tests

```sh
node bin/axure.mjs --help
node bin/axure.mjs rp-read /absolute/path/to/project.rp --json
node bin/mcp.mjs
npm test
npm run test:language
npm run test:runtime
npm run test:trace
node scripts/pack-release.mjs -o /absolute/path/to/new-source-directory
```

Configure your MCP client with `command: "node"` and `args: ["/absolute/path/to/zee-rp/bin/mcp.mjs"]`, with matching template environment variables. Agent usage: [SKILL.md](SKILL.md). Low-level commands: [command table](references/commands-generated.md).

`npm test` needs no Axure. Other suites have additional requirements listed in [CONTRIBUTING.md](CONTRIBUTING.md). Structure and simulation checks do not prove GUI editing or native preview behavior.

Demo screenshots, icons and generic phone frames are original geometric artwork from [generate-assets.py](examples/generate-assets.py). No third-party screenshots, official binaries, native templates or font files are distributed. Source and original demo assets: [MIT](LICENSE).
