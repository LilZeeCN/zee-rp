# Contributing

Use Node.js 18 or newer. Run `npm test` before submitting a change. For changes to `.rp` writers, also run `npm run test:native` with a local native blank template and library. For MCP changes, install dependencies with `npm ci` and run `npm run test:mcp`. See [validation](docs/validation.md) for prerequisites and historical fixture checks.

Include a reproducible public recipe or test for the changed behavior. Report offline structure, native load, preview behavior, and GUI edit/save/reopen separately. Do not describe skipped prerequisites or mock GUI jobs as real native acceptance.

Never commit native `.rp`/`.rplib` files, the Axure application/runtime, vendor assets, decompiled code, private paths, credentials, or user documents. Tests must create new output files and clean temporary data. Public examples contain authored specifications and source recipes, not redistributed native inputs.

The script registry must cover all production `.mjs` files. Generate command documentation with `node scripts/gen-capabilities.mjs -o <new-file.md>`, review it, then replace the tracked command document. After an intentional production change, explicitly migrate the changed SHA in `test/baseline-shas.json` and explain the behavior change in the changelog; never update historical native fixture fingerprints to hide a regression.

Check the release with `node scripts/pack-release.mjs -o <new-directory>` and `npm pack --dry-run`. The release must retain source, schemas, tests, both READMEs, docs, and example recipes. Excluded native inputs remain the user's responsibility.
