# Changelog

## 0.1.1 — 2026-10-13

- Sync the previously omitted expression/condition contracts, rich-text links/list/spacing/full style keys, multi-run table cells, custom/nested connector cloning, and recent page/panel/master fixes from the current implementation.
- Publish expression/widget schema probes, the capabilities generator, global-variable writer, and all historical test source with configurable native input locations and compact fixture fingerprints.
- Register the global-variable writer in CLI/MCP; fix MCP default-value forwarding and rich-text paragraph schemas. Move the rich-text CLI invocation after hyperlink template initialization.
- Add public, native-free checks, locally generated native demos/tests, and real MCP transport tests. Separate historical fixture tests from default public tests.
- Preserve implementations and tests in release packaging; include bilingual documentation, correct executable examples, and generated command reference.
- Replace the old repository screenshot with an authored specification and deterministic reference SVG. Previous Git history is preserved.

## 0.1.0

Initial public release. Its README's 225-check claim did not describe the public `npm test` entry point; its distribution lagged the local implementation. Those claims and omissions are corrected in 0.1.1.
