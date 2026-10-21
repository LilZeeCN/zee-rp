# Original screenshot example

`source.png` is a fictional dashboard drawn by [generate-assets.py](../generate-assets.py) with original geometry and invented data, covered by the project MIT license. No third-party interface or personal content is used.

From the repository root, with Python dependencies activated:

```sh
node scripts/trace.mjs draft examples/screenshot/source.png -o outputs/screenshot --scale 1 --axvg outputs/screenshot/page.axvg.json
```

Inspect OCR and the comparison. Follow the [screenshot workflow](../../references/screenshot-workflow.md) to paste and save in Axure. This visual input does not contain business interactions.
