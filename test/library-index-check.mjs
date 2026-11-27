import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { synthesizeBlankProject } from '../scripts/blank-synthesizer.mjs';
import { cloneLibraryWidget } from '../scripts/clone-library-widget.mjs';
import { indexLibrary } from '../scripts/index-library.mjs';
import { writeNativeScene } from '../scripts/native-scene.mjs';
import { readRp } from '../scripts/rp-read.mjs';

test('library index identifies named and duplicate widgets and supports cloning by record and object id', t => {
  const work = mkdtempSync(join(tmpdir(), 'zee-library-index-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const source = join(work, 'design.rplib'), target = join(work, 'target.rp'), output = join(work, 'result.rp');
  const items = ['Choose', 'Choose', 'Unique'].map((name, index) => ({
    itemType: 1, type: 0, name, rect: { location: { x: index * 100, y: 20 }, size: { width: 90, height: 40 } },
    text: { paragraphs: [{ horizontalAlignment: 0, inlines: [{
      text: `Text ${index}`, family: 'Arial', size: 16, weight: 400, textColor: { r: 0, g: 0, b: 0 },
    }] }] },
  }));
  const bytes = writeNativeScene(synthesizeBlankProject({ version: 9, pageName: 'Controls' }), { scene: { items } });
  writeFileSync(source, bytes);
  writeFileSync(target, synthesizeBlankProject({ version: 9 }));
  const index = indexLibrary(source);
  assert.deepEqual(index.counts, { pages: 1, widgets: 3 });
  const [page] = index.pages;
  assert.equal(page.name, 'Controls');
  assert.deepEqual(page.widgets.map(widget => [widget.name, widget.width, widget.height, widget.text]), [
    ['Choose', 90, 40, 'Text 0'], ['Choose', 90, 40, 'Text 1'], ['Unique', 90, 40, 'Text 2'],
  ]);
  const options = { sourcePageName: `#${page.record}`, targetPageName: 'Page 1', name: 'Imported' };
  assert.throws(() => cloneLibraryWidget(source, target, output, { ...options, sourceWidget: 'Choose' }), /matched 2 widgets/);
  cloneLibraryWidget(source, target, output, { ...options, sourceWidget: `#${page.widgets[1].id}` });
  const summary = readRp(readFileSync(output));
  assert.deepEqual(summary.pages[0].widgets.map(widget => [widget.name, widget.x, widget.text]), [['Imported', 100, 'Text 1']]);
  assert.equal(summary.counts.danglingRefs, 0);
  assert.equal(summary.counts.problems, 0);
  assert.deepEqual(readFileSync(source), bytes);
  const namedOutput = join(work, 'named.rp');
  cloneLibraryWidget(source, target, namedOutput, { ...options, sourceWidget: 'Unique' });
  assert.equal(readRp(readFileSync(namedOutput)).pages[0].widgets[0].text, 'Text 2');
});
