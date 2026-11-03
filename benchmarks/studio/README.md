# Studio reproducible task and evidence baseline

`tasks.json` defines eight fixed tasks, required content and states, edit scope, budgets, and replayable scenario assertions. These definitions are not completed product trials. `result.schema.json`, `call-ledger.schema.json` and `result-template.json` keep measured outcomes separate from pending evidence. Unknown tokens are null, failed and timed-out attempts count, and agent ratings are not user acceptance.

Run `npm run test:studio-baselines` to validate definitions. Inventory the live implementation with `python3 benchmarks/studio/audit.py inventory --root /absolute/source --out /absolute/audit --label current --workspace-root /absolute/workspace`; `--baseline` takes the prior `inventory.json` file. `validate.py --audit /absolute/audit` checks a saved inventory. The inventory distinguishes declared fields, static consumer candidates and runtime evidence; a static match is not a passing behavior test.

Use `replay.mjs` on an authored project to execute the task's required scenarios. Preserve input source, revision/hash, screenshots, all call attempts, failures and repairs. Record semantic execution, real browser pointer actions, native structure, Axure load/preview, GUI edits/save-reopen and independent visual review separately. Do not count definition validation as eight successful runs, or prior familiar trials as new blind comparison data.

See [performance baseline](perf-README.md) for deterministic scale fixtures, actual measurement boundaries and unsupported cells. The first baseline has all 12 core cells and three text-browser cells; other browser categories are not yet measured.
