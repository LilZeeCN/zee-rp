<div align="center">

# ⚡ zee-rp

**An open-source engine & MCP server for Axure RP 11 prototype files.**

*Turn screenshots, HTML, or specs into editable Axure widgets. Let AI read, modify,
and generate real `.rp` files — verified against the native Axure app.*

[Quick Start](#-quick-start) • [MCP Setup](#-mcp-integration) • [Capabilities](#-capability-matrix) • [Safety](#-safety-model)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node Version](https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen.svg)](package.json)
[![Zero Dependencies](https://img.shields.io/badge/Runtime_Dependencies-0-orange.svg)](package.json)
[![Regression Tests](https://img.shields.io/badge/Regression_Tests-225%2F225-success.svg)](test/)
[![MCP Tools](https://img.shields.io/badge/MCP-42_Tools-purple.svg)](bin/mcp.mjs)

</div>

> **Trademark notice** — Axure RP is a registered trademark of Axure Software
> Solutions, Inc. zee-rp is an independent open-source research and tooling
> project. It is **not** affiliated with, sponsored by, or endorsed by
> Axure Software Solutions, Inc.

---

## 💡 What is zee-rp?

For two decades, **Axure RP** has been the industry standard for high-fidelity
enterprise prototyping — yet its proprietary `.rp` binary format has remained an
undocumented black box. No public spec, no official API. Programmatic editing
and AI generation of real Axure prototypes have been effectively impossible.

zee-rp changes that.

Built on months of meticulous reverse engineering and IL-level analysis of the
file format, zee-rp is a **zero-dependency Node.js engine** that natively
parses, constructs, and edits Axure RP 11 prototype files. Paired with a
**42-tool MCP server**, it lets AI agents (Claude, Cursor, Codex, Windsurf)
work directly with real `.rp` files:

- 📦 **0 runtime dependencies** — pure ESM JavaScript, 9,000+ lines of original code
- 🔬 **Format truth, not guesswork** — custom LZ4 manifest codec, .NET typed
  binary payload parser, GUID closure resolution
- 🛡️ **Safety-first writes** — atomic chain-style work copies, sandboxed write
  roots, automatic rollback on any structural failure

## 📸 See It in Action

A full-page UI screenshot, reconstructed as a native Axure page: **121 editable
widgets, 16 embedded images, mean pixel divergence 7.97/255** — not a flat
picture, but real widgets you keep editing in Axure.

![Visual result vs editable widget boundaries](assets/demo-comparison.png)

*Left: the rendered page. Right: the same page with every widget independently
selectable and editable inside Axure RP.*

## 🚀 Highlights

* 🧠 **Reverse-engineered binary core** — parses and re-encodes the LZ4 manifest,
  gzip record boundaries, and the .NET typed-tag payload graph with GUID closure.
* 🤖 **Native MCP integration** — 42 tools: inspect page trees, locate widgets,
  batch-edit text and rich text, inject/remove interactions, manage repeater
  data, verify file integrity, and drive GUI roundtrip jobs.
* 👁️ **Vision → Axure** — feed a screenshot, HTML snapshot, or layout spec and
  get genuine editable widgets: vector shapes, native text runs, embedded images.
* ⚡ **Real interactive fidelity** — programmatically builds native Axure behavior:
  * Dynamic panels (multi-state, nested, fit-to-content)
  * Repeaters (datasets, sorting, filtering, row CRUD, pagination)
  * Conditional logic (If / ElseIf / Else with recursive expression trees)
  * Masters (definitions, dependency trees, instance text/image overrides)
  * Connectors (default and custom anchor points), adaptive views, native tables
* ✅ **Everything is evidence-graded** — 225/225 automated regression checks,
  and verified behavior against real Axure RP 11 save/close/reopen cycles.

## 🛠️ Quick Start

**Prerequisites:** Node.js ≥ 18, Axure RP 11 (verified on macOS, build
11.0.0.4137; Windows not yet tested).

Zero build step, zero `npm install` for the core CLI:

```bash
# Inspect any existing .rp prototype
node bin/axure.mjs rp-read /absolute/path/to/source.rp --json

# Safely rewrite one widget's text into a new file
node bin/axure.mjs set-widget-text /path/to/source.rp /path/to/output.rp \
  "Page 1" "SubmitButton" "Click to Confirm"
```

All writes go to **new files** — your source `.rp` is never modified in place.

### Local blank template

This repo deliberately ships **no Axure `.rp` or `.rplib` files**. To create
new projects from scratch, save a single-page empty project from your own
Axure RP 11 install once, then point zee-rp at it:

```bash
export AXURE_BLANK_TEMPLATE=/absolute/my-native-blank.rp
node bin/axure.mjs create-blank-project /absolute/output-root/new.rp
```

If unset, zee-rp falls back to
`~/Library/Application Support/zee-rp/templates/axure-rp11-blank.rp`.

## 🤖 MCP Integration (Claude / Cursor / Codex / Windsurf)

```bash
npm ci --ignore-scripts   # optional: installs the MCP SDK only
node bin/mcp.mjs
```

The SDK is an *optional* dependency used only by the MCP server; the core CLI
runs with zero installs. Add to your MCP client config:

```json
{
  "mcpServers": {
    "zee-rp": {
      "command": "node",
      "args": ["/absolute/path/to/zee-rp/bin/mcp.mjs"],
      "env": {
        "AXURE_WRITE_ROOT": "/safe/output/directory",
        "AXURE_BLANK_TEMPLATE": "/path/to/blank-template-from-your-Axure-install.rp"
      }
    }
  }
}
```

Then just tell your agent:

> "Find all buttons labeled 'Cancel' on Page 1, restyle them to a gray
> outline, and add a Click interaction that closes the modal panel."

The MCP session layer copies your source into a chain of work files
(`source.work-1.rp`, `source.work-2.rp`, …). Every step is structurally
verified before it commits; a failing step is kept as `.rejected` and the
chain rolls back — your original file is never touched.

## 🛡️ Safety Model

* **Protected paths** — set `AXURE_PROTECTED_PATHS` (colon-separated absolute
  paths) to mark files the engine must refuse to touch as input *or* output.
  Resolution survives symlinks and case-variant paths on macOS/Windows.
* **Write root sandbox** — set `AXURE_WRITE_ROOT` (colon-separated roots) and
  every output is required to land inside them; anything else is rejected
  before a single byte is written.
* **Three-zero rule** — a generated file only ships if it shows 0 unparseable
  records, 0 dangling references, 0 structural problems.

## 📊 Capability Matrix

| Domain | Capabilities | Verification |
|---|---|---|
| Binary .rp I/O | LZ4 manifest round-trip, record graph, page/master duplication, blank project & page creation | GUI save/reopen verified |
| Rich text | Multi-run styles, line spacing, alignment, hyperlinks (page & URL), native bullet lists (structural) | Native canvas verified |
| Dynamic panels | Multi-state creation, nested closures, append/replace, fit-to-content | GUI roundtrip verified |
| Repeaters | Dataset CRUD, row templates, sort & filter rules, items-per-page | Preview behavior verified |
| Interactions | 45 event types, 29 action writers, If/ElseIf/Else with recursive conditions, 18 registered expression functions | 225/225 regression + sampled GUI verification |
| Native tables | Dimension matrix, per-cell multi-run text, visual merge overlays | Native canvas verified |
| Connectors | Default edges, normalized custom anchor points, cross-document style sync | Preview verified |
| Adaptive views | Base / 768 / 1024 breakpoints with per-view overrides | Preview verified |

Capability claims are deliberately conservative: each row is backed by specific
verified samples on macOS / Axure RP 11.0.0.4137, and the project explicitly
separates *structure correct* from *loads*, *preview behavior*, and *GUI
edit/save/reopen verified*. See [references/capabilities.md](references/capabilities.md)
for exact boundaries — nothing is extrapolated.

## 🏛️ Architecture

```
              ┌─────────────────────────┐
              │  Claude / Agent / CLI   │
              └───────────┬─────────────┘
                          │ (MCP / CLI)
              ┌───────────▼─────────────┐
              │      zee-rp engine      │
              │ (sandbox & registry)    │
              └───────────┬─────────────┘
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
 ┌─────────────┐   ┌──────────────┐   ┌──────────────┐
 │ rp-records  │   │ parse-payload│   │  ix-actions  │
 │ LZ4/gzip    │   │ typed-tag    │   │ expression & │
 │ record I/O  │   │ tree engine  │   │ FCall registry│
 └─────────────┘   └──────────────┘   └──────────────┘
        └─────────────────┼─────────────────┘
                          ▼
              ┌─────────────────────────┐
              │    Axure RP 11 (.rp)    │
              └─────────────────────────┘
```

## 🧪 Verification Discipline

We don't guess — we verify against the native application:

* **Regression suite** — automated assertions over record structures,
  expression serialization, and layout closures (`npm test`; the full 225-check
  suite runs in the development environment, the shipped parity/safety checks
  run against your local template).
* **Parity & safety checks** — `node test/parity-check.mjs` proves the unified
  CLI is byte-identical to direct script execution and exercises the
  protected-path / write-root rejections.
* **GUI roundtrips** — generated files are opened in real Axure RP 11, saved,
  closed, and re-parsed from disk to prove native compatibility.

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Short version: PRs must not add Axure
`.rp`/`.rplib` binaries or any official Axure assets; tests need a local
Axure RP 11 install and blank template.

## 📄 License & Disclaimer

MIT License — see [LICENSE](LICENSE).

zee-rp is an independent open-source research and tooling initiative. Axure RP
is a registered trademark of Axure Software Solutions, Inc. This project is
not affiliated with, sponsored by, or endorsed by Axure Software Solutions, Inc.

---

Star ⭐ if zee-rp saved you hours of prototype drawing!
