# Studio performance baseline

`perf-baseline.mjs` generates deterministic expanded-node fixtures and measures the existing product without modifying it. It freezes runtime files into an output directory, links canonical node_modules, and uses one dedicated worker per category/size. Pass an existing frozen runtime to reproduce that exact product baseline. `--studio-source` can select a previously saved studio snapshot when first freezing a runtime.

```sh
node benchmarks/studio/perf-baseline.mjs --output=/absolute/output --samples=30 --sizes=1000,5000,10000 --browser=text
node benchmarks/studio/perf-report.mjs /absolute/output/results.json
```

`perf-fixtures.mjs` covers text, shared small raster images, component instances, and ten-page documents. Sizes count expanded scene nodes including page roots. Images are 16 shared 64×48 PNGs; this fixture does not represent thousands of independent large photographs. Component fixtures keep the expanded count equal to the requested scale and report source-node counts separately.

Core phases are first scene, repeated clone/hash/scene, local transaction, durable save, recovery, and a new-project open after the worker has warmed caches. Repeated phases record raw values and nearest-rank p50/p95. Transactions include product history and impact-analysis overhead. Save ends at product durableRevision; recovery compares persisted revision/hash. First scene/open have one sample each and are not p95 or repeatable cold-start claims.

The default browser matrix only measures text at each scale. Other browser cells are explicitly `not_run`; expand with `--browser=text,images,components,multipage`. Browser edits wait for matching revision/hash, verify DOM text, wait for fonts/two animation frames, and capture the actual target region through CDP. API response time is separately recorded. The screenshot endpoint includes CDP/encoding overhead and proves a Chromium composited state, not physical screen presentation. Continuous frame samples use synthetic DOM wheel events through the real product listener; they are not hardware-input measurements.

Only dedicated headless Chrome processes/profiles are created and closed. Existing projects, ports, and user browsers are not attached. Workers use system-assigned ports. Parent-process RSS polling includes the worker and its descendants every 200ms; Node maxRSS is also retained. RSS sums can double-count shared pages, and short spikes can be missed. Runtime/fixture/harness SHA manifests, machine/runtime/viewport metadata, raw samples, screenshots, long tasks, memory samples, and failures are retained. Per-run temporary project histories are removed on completion. Product source, package files and CI are not changed.
