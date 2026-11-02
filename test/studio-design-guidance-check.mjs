import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDesignGuidance } from '../studio/design-guidance.mjs';
import { benchmarkRoot, getDesignContext, verifyBenchmarkFiles } from '../studio/design-context.mjs';

const bytes = value => Buffer.byteLength(JSON.stringify(value));

test('all legacy intents have complete task/platform guidance without inventing accepted references', () => {
  const selected = [];
  for (const platform of ['mobile', 'web']) for (const intent of ['editorial', 'task', 'learning']) {
    const result = getDesignContext({ intent, platform, includeImages: false });
    const { guide, provenance, brief, reviewQuestions } = result.designGuidance;
    selected.push(guide.id);
    assert.equal(result.platform, platform);
    assert.ok(guide.platforms.includes(platform));
    assert.ok(guide.intents.includes(intent));
    for (const field of ['bestFor', 'composition', 'typography', 'palette', 'spacing', 'materials', 'states', 'avoid', 'explore', 'rp1']) assert.ok(guide[field], field);
    assert.equal(provenance.type, 'authored-guidance');
    assert.equal(provenance.userAccepted, false);
    assert.ok(brief.content.includes('不编造'));
    assert.ok(brief.states.includes('期望'));
    assert.ok(reviewQuestions.length >= 4);
    if (intent !== 'editorial') {
      assert.equal(result.reference, null);
      assert.ok(bytes(result) <= 8192, `${platform}/${intent}: ${bytes(result)} bytes`);
    }
  }
  assert.equal(new Set(selected).size, 5);
});

test('guide discovery and explicit choice provide six distinct families and structural explorations', () => {
  const ids = new Set();
  for (const platform of ['mobile', 'web']) {
    const discovered = getDesignGuidance({ platform });
    for (const entry of discovered.availableGuides) {
      ids.add(entry.id);
      const { guide } = getDesignGuidance({ platform, guideId: entry.id });
      assert.equal(guide.id, entry.id);
      assert.equal(guide.explore.length, 3);
      assert.equal(new Set(guide.explore.map(direction => direction.structure)).size, 3);
      assert.equal(new Set(guide.explore.map(direction => direction.visual)).size, 3);
      assert.ok(guide.composition.readingOrder.length >= 3);
      assert.ok(!Object.hasOwn(guide, 'root'));
      assert.ok(!Object.hasOwn(guide, 'commands'));
      for (const color of Object.values(guide.palette)) assert.match(color, /^#[0-9A-F]{6}$/);
    }
  }
  assert.deepEqual([...ids].sort(), ['data-workspace', 'field-story', 'learning-route', 'recall-focus', 'record-form', 'task-instrument']);
});

test('explicit cross-intent choices stay explicit while unsupported platforms fail with usable alternatives', () => {
  const result = getDesignGuidance({ intent: 'learning', platform: 'web', guideId: 'record-form' });
  assert.equal(result.guide.id, 'record-form');
  assert.equal(result.matchesIntent, false);
  assert.throws(() => getDesignContext({ platform: 'tablet' }), { code: 'E_DESIGN_PLATFORM' });
  assert.throws(() => getDesignContext({ intent: 'unknown' }), { code: 'E_DESIGN_INTENT' });
  assert.throws(() => getDesignContext({ platform: 'web', guideId: 'missing' }), error => error.code === 'E_DESIGN_GUIDE' && error.message.includes('data-workspace') && error.candidates.includes('record-form'));
  assert.throws(() => getDesignContext({ platform: 'web', guideId: 'recall-focus' }), error => error.code === 'E_DESIGN_GUIDE_PLATFORM' && error.allowedPlatforms.includes('mobile'));
});

test('returned recipes and catalog entries do not share mutable state between calls', () => {
  const first = getDesignGuidance({ intent: 'learning' });
  first.guide.palette.brand = 'changed';
  first.guide.composition.readingOrder.length = 0;
  first.guide.explore[0].structure = 'changed';
  first.availableGuides[0].intents.length = 0;
  const second = getDesignGuidance({ intent: 'learning' });
  assert.equal(second.guide.palette.brand, '#3D4AC8');
  assert.ok(second.guide.composition.readingOrder.length);
  assert.notEqual(second.guide.explore[0].structure, 'changed');
  assert.ok(second.availableGuides[0].intents.length);
});

test('editorial references preserve complete metadata, exact page sources and opt-in image behavior', () => {
  const source = JSON.parse(readFileSync(join(benchmarkRoot, 'source.json')));
  const metadata = JSON.parse(readFileSync(join(benchmarkRoot, 'benchmark.json')));
  for (const pageId of ['home', 'species', 'record', 'saved']) {
    const plain = getDesignContext({ pageId, includeImages: false });
    assert.equal(plain.reference.id, metadata.id);
    for (const [key, value] of Object.entries(metadata)) assert.deepEqual(plain.reference[key], value);
    assert.deepEqual(plain.reference.pageSource, source.pages.find(page => page.id === pageId));
    assert.equal(plain.reference.selectedPage, pageId);
    assert.equal(plain.mcpImages, undefined);
    const withImage = getDesignContext({ pageId });
    assert.deepEqual(Buffer.from(withImage.mcpImages[0].data, 'base64'), readFileSync(join(benchmarkRoot, 'previews', `${pageId}.png`)));
    assert.deepEqual(withImage.reference, plain.reference);
  }
  assert.throws(() => getDesignContext({ pageId: 'missing' }), { code: 'E_REFERENCE_PAGE' });
  assert.equal(getDesignContext({ intent: 'learning', pageId: 'lesson' }).ok, true);
});

test('the benchmark verifier rejects both changed and missing frozen files without mutating fixtures', () => {
  const root = mkdtempSync(join(tmpdir(), 'zee-guidance-manifest-'));
  try {
    const original = 'frozen design';
    const sha = createHash('sha256').update(original).digest('hex');
    writeFileSync(join(root, 'source.json'), original);
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ files: { 'source.json': sha } }));
    verifyBenchmarkFiles(root);
    writeFileSync(join(root, 'source.json'), 'changed design');
    assert.throws(() => verifyBenchmarkFiles(root), { code: 'E_BENCHMARK_DRIFT' });
    assert.equal(readFileSync(join(root, 'source.json'), 'utf8'), 'changed design');
    rmSync(join(root, 'source.json'));
    assert.throws(() => verifyBenchmarkFiles(root), { code: 'E_BENCHMARK_DRIFT' });
    verifyBenchmarkFiles();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
