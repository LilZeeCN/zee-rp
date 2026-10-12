# Contributing to zee-rp

Thanks for your interest! A few ground rules that keep this project safe and
verifiable:

## Hard rules

1. **No Axure-owned assets.** Never commit `.rp`, `.rplib`, `.dll`, or any
   file derived from an official Axure template, widget library, or the Axure
   application itself. This includes test fixtures — generate sample files
   from your own local blank template instead.
2. **No copied vendor code.** zee-rp is a clean-room, independent
   implementation. Decompiled or extracted Axure source must not enter this
   repository in any form.
3. **Trademark respect.** Don't rename the project or its branding to include
   the word "Axure", and don't use Axure's logo/icon. Descriptive uses like
   "works with Axure RP 11" are fine.

## Development setup

* Node.js ≥ 18. Core scripts use only built-in modules — no install needed.
* Functional testing requires a local **Axure RP 11** install (verified on
  macOS, build 11.0.0.4137). Save a single-page empty project from Axure and
  export its path:

  ```bash
  export AXURE_BLANK_TEMPLATE=/absolute/my-native-blank.rp
  ```

* Run the shipped checks:

  ```bash
  node test/parity-check.mjs   # CLI parity + safety rejections + baseline SHAs
  npm ci --ignore-scripts      # optional MCP SDK, only needed for MCP work
  node test/jobs-check.mjs     # GUI job manager (mock runner, macOS)
  ```

## Verification discipline

This project separates *structure correct* → *loads in Axure* → *preview
behavior* → *GUI edit/save/reopen verified*. When you add a capability,
state which level your evidence covers and don't extrapolate beyond your
samples. See `references/verification.md`.

## Reporting issues

Include: Axure build number, OS, the zee-rp command or MCP tool you used, and
whether your `.rp` file can be shared (never attach files you can't license).

zee-rp is not affiliated with Axure Software Solutions, Inc. Axure RP is a
registered trademark of Axure Software Solutions, Inc.
