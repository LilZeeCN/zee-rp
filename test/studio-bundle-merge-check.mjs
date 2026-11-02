import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStudioServer } from '../studio/server.mjs';
import { studioHandlers, closeInProcessStudioServer } from '../studio/mcp-adapter.mjs';
import {
  verifyProjectBundle,
  importProjectBundle,
  migrateAndPreserveSchema,
  buildBundleCompatibilityReport,
} from '../studio/project-bundle.mjs';
import { mergeStudioDocuments } from '../studio/document-merge.mjs';
import { importToStudioDocument } from '../studio/document.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { nativeTemplateSkipReason } from './host-capabilities.mjs';

// 1x1 Valid PNG
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function createSampleSourceSpec(externalAssetPath) {
  return {
    name: 'Portable Studio App',
    domain: 'mobile',
    theme: 'light',
    palette: {
      brand: '#1E40AF',
      surface: '#F8FAFC',
      ink: '#0F172A',
    },
    tokens: {
      brand: '#1E40AF',
      cardGap: 16,
      headingSize: 24,
    },
    variables: {
      savedCount: 1,
    },
    datasets: {
      notes: {
        model: ['id', 'title', 'tag'],
        rows: [
          { id: 'n1', title: '海风观测记录', tag: '海岸' },
          { id: 'n2', title: '潮汐高程样本', tag: '潮汐' },
        ],
      },
    },
    components: {
      InfoBadge: {
        name: 'InfoBadge',
        contract: {
          componentId: 'info-card',
          version: '1.0.0',
        },
        root: {
          id: 'badge_root',
          type: 'box',
          layout: 'row',
          w: 160,
          h: 36,
          padding: [6, 12, 6, 12],
          fill: '#EFF6FF',
          radius: 8,
          children: [
            {
              id: 'badge_label',
              type: 'label',
              text: '默认徽章',
              fontSize: 13,
              color: '$brand',
              w: 120,
              h: 20,
            },
          ],
        },
      },
    },
    pages: [
      {
        id: 'home',
        name: '首页',
        domain: 'mobile',
        root: {
          id: 'home_root',
          type: 'box',
          layout: 'column',
          x: 0,
          y: 0,
          w: 390,
          h: 844,
          padding: [24, 20, 24, 20],
          gap: '$cardGap',
          fill: '#F8FAFC',
          children: [
            {
              id: 'hero_title',
              type: 'label',
              role: 'heading',
              text: '海岸田野笔记',
              fontFamily: 'Zee Studio Test Sans',
              fontSize: '$headingSize',
              color: '#0F172A',
              w: 350,
              h: 36,
            },
            {
              id: 'hero_cover',
              type: 'image',
              src: externalAssetPath,
              w: 350,
              h: 160,
              radius: 12,
            },
            {
              id: 'badge_inst',
              type: 'instance',
              component: 'InfoBadge',
              w: 160,
              h: 36,
              overrides: {
                badge_label: { text: '已归档样本' },
              },
            },
            {
              id: 'detail_panel',
              type: 'paragraph',
              text: '点击下方按钮展开详细潮汐观测说明。',
              visible: false,
              w: 350,
              h: 56,
              fontSize: 14,
              color: '#334155',
            },
            {
              id: 'toggle_btn',
              type: 'button',
              role: 'primary-action',
              text: '展开详情',
              w: 350,
              h: 48,
              fill: '$brand',
              color: '#FFFFFF',
              radius: 10,
              on: {
                click: [
                  { type: 'show', target: 'detail_panel' },
                  { type: 'set-variable', variable: 'savedCount', value: 2 },
                ],
              },
            },
          ],
        },
      },
    ],
  };
}

test('P02: portable project bundle exports full closure, strips absolute paths, detects tampering, and works after deleting original source & project directories', { timeout: 60000 }, async t => {
  const workRoot = mkdtempSync(join(tmpdir(), 'studio-p02-bundle-'));
  const origSourceDir = join(workRoot, 'orig-source');
  const origProjectDir = join(workRoot, 'orig-project');
  const bundleDir = join(workRoot, 'portable-bundle');
  const relocatedProjectDir = join(workRoot, 'relocated-project');

  mkdirSync(origSourceDir, { recursive: true });
  const externalImgPath = join(origSourceDir, 'cover-photo.png');
  writeFileSync(externalImgPath, TINY_PNG);
  const specPath = join(origSourceDir, 'spec.json');
  writeFileSync(specPath, JSON.stringify(createSampleSourceSpec(externalImgPath), null, 2), 'utf8');

  let studio1 = null;
  let studio2 = null;
  try {
    // 1. Start original project from external sourcePath
    const started1 = await startStudioServer({
      projectDir: origProjectDir,
      sourcePath: specPath,
      name: 'Portable Studio App',
      port: 0,
    });
    studio1 = started1.studio;

    // Copy external asset into project assets & register local font file
    mkdirSync(join(origProjectDir, 'assets'), { recursive: true });
    writeFileSync(join(origProjectDir, 'assets', 'cover-photo.png'), TINY_PNG);
    mkdirSync(join(origProjectDir, 'fonts'), { recursive: true });
    cpSync(new URL('./fixtures/fonts/studio-test-sans.ttf', import.meta.url), join(origProjectDir, 'fonts', 'studio-test-sans.ttf'));

    // Update image src to relative assets/cover-photo.png and add a design decision + version
    const rev1 = studio1.store.appliedRevision;
    const applyRes = await studioHandlers.studio_apply_commands({
      url: studio1.url,
      baseRevision: rev1,
      idempotencyKey: 'prep-portable-assets',
      commands: [
        {
          type: 'setProperties',
          pageId: 'home',
          nodeId: 'hero_cover',
          properties: { src: 'assets/cover-photo.png' },
        },
        {
          type: 'recordDesignDecision',
          decisionId: 'dec-shore-direction',
          scope: { kind: 'project' },
          subject: 'direction',
          outcome: 'accepted',
          choice: '采用海岸纪实极简留白方向',
          reason: '突出潮汐观测数据与田野照片对比',
        },
      ],
    });
    assert.equal(applyRes.ok, true, JSON.stringify(applyRes));

    // Register local font in doc.fonts.catalog and persist
    studio1.store.doc.fonts = {
      catalog: [
        { family: 'Zee Studio Test Sans', path: 'fonts/studio-test-sans.ttf', source: 'project' },
      ],
      fallbacks: {
        'Zee Studio Test Sans': ['sans-serif'],
      },
    };
    studio1.persistence.saveFullSnapshot(studio1.store.doc);

    // Create a named version
    const verRes = await studioHandlers.studio_project_versions({
      url: studio1.url,
      action: 'create',
      name: 'v1-portable-ready',
      baseRevision: studio1.store.appliedRevision,
      idempotencyKey: 'create-v1-portable-ready',
    });
    assert.equal(verRes.ok, true, JSON.stringify(verRes));

    // 2. Export portable bundle
    const exportRes = await studioHandlers.studio_project_bundle({
      url: studio1.url,
      action: 'export',
      outDir: bundleDir,
    });
    assert.equal(exportRes.ok, true);
    assert.equal(exportRes.manifest.format, 'zee-studio-bundle/v1');
    assert.equal(exportRes.compatibilityReport.portable, true);
    assert.equal(exportRes.compatibilityReport.summary.missingAssets, 0);
    assert.equal(exportRes.compatibilityReport.summary.missingFonts, 0);
    assert.equal(exportRes.compatibilityReport.summary.missingComponents, 0);

    // 3. Verify bundle integrity & zero absolute path leak
    const verifyRes = verifyProjectBundle({ bundleDir });
    assert.equal(verifyRes.ok, true);
    assert.equal(verifyRes.absolutePathLeaks.length, 0);

    // Check tamper detection on a copy of the bundle
    const tamperedBundleDir = join(workRoot, 'tampered-bundle');
    cpSync(bundleDir, tamperedBundleDir, { recursive: true });
    writeFileSync(join(tamperedBundleDir, 'assets', 'cover-photo.png'), Buffer.from('corrupted'));
    const tamperedVerify = verifyProjectBundle({ bundleDir: tamperedBundleDir });
    assert.equal(tamperedVerify.ok, false);
    assert.ok(tamperedVerify.issues.some(i => i.code === 'E_BUNDLE_FILE_HASH_MISMATCH'));

    // 4. Close original studio server and DELETE both origSourceDir and origProjectDir!
    await studio1.close();
    studio1 = null;
    rmSync(origSourceDir, { recursive: true, force: true });
    rmSync(origProjectDir, { recursive: true, force: true });
    assert.equal(existsSync(origSourceDir), false);
    assert.equal(existsSync(origProjectDir), false);

    // 5. Import bundle into relocatedProjectDir
    const importRes = await studioHandlers.studio_project_bundle({
      action: 'import',
      bundleDir,
      targetProjectDir: relocatedProjectDir,
    });
    assert.equal(importRes.ok, true);
    assert.equal(existsSync(join(relocatedProjectDir, 'document.json')), true);
    assert.equal(existsSync(join(relocatedProjectDir, 'assets', 'cover-photo.png')), true);
    assert.equal(existsSync(join(relocatedProjectDir, 'fonts', 'studio-test-sans.ttf')), true);

    // 6. Start a new Studio server on relocatedProjectDir and verify open, screenshot, edit, scenario, and .rp export
    const started2 = await startStudioServer({
      projectDir: relocatedProjectDir,
      port: 0,
    });
    studio2 = started2.studio;

    const ctx = await studioHandlers.studio_get_context({ url: studio2.url, verbose: true, includeDoc: true });
    assert.equal(ctx.ok, true);
    assert.equal(ctx.doc.name, 'Portable Studio App');
    assert.equal(ctx.doc.designDecisions.length, 1);

    // Verify named versions survived relocation
    const versionsList = await studioHandlers.studio_project_versions({
      url: studio2.url,
      action: 'list',
    });
    assert.equal(versionsList.ok, true);
    assert.equal(versionsList.versions.length, 1);
    assert.equal(versionsList.versions[0].name, 'v1-portable-ready');

    // Capture screenshot on relocated project
    const shotPath = join(workRoot, 'relocated-home.png');
    const shotRes = await studioHandlers.studio_capture_screenshot({
      url: studio2.url,
      pageId: 'home',
      outPath: shotPath,
    });
    assert.equal(shotRes.ok, true);
    assert.equal(existsSync(shotPath), true);
    assert.ok(shotRes.width >= 390 && shotRes.height >= 844);

    // Edit on relocated project
    const editRes = await studioHandlers.studio_apply_commands({
      url: studio2.url,
      baseRevision: studio2.store.appliedRevision,
      idempotencyKey: 'relocated-edit-1',
      commands: [
        { type: 'setText', pageId: 'home', nodeId: 'hero_title', text: '海岸田野笔记（迁移后编辑）' },
      ],
    });
    assert.equal(editRes.ok, true);

    // Compare relocated project against original bundle
    const cmpRes = await studioHandlers.studio_project_bundle({
      url: studio2.url,
      action: 'compare',
      bundleDir,
    });
    assert.equal(cmpRes.ok, true);
    assert.ok(cmpRes.diff.total >= 1);

    // Run interactive scenario on relocated project
    const scenRes = await studioHandlers.studio_run_scenario({
      url: studio2.url,
      startPageId: 'home',
      steps: [
        { action: 'expect', expect: { visible: { detail_panel: false } } },
        { action: 'click', target: 'toggle_btn' },
        { action: 'expect', expect: { visible: { detail_panel: true }, variables: { savedCount: 2 } } },
      ],
    });
    assert.equal(scenRes.ok, true);
    assert.equal(scenRes.finalState?.variables?.savedCount, 2);

    // Export native .rp on relocated project
    await t.test('relocated project exports native RP9 when the host template is available', { skip: nativeTemplateSkipReason() }, async () => {
      const outRpPath = join(workRoot, 'relocated.rp');
      const rpRes = await studioHandlers.studio_export_rp({
        url: studio2.url,
        outRpPath,
      });
      assert.equal(rpRes.ok, true, JSON.stringify(rpRes));
      const rpData = readRp(readFileSync(outRpPath));
      assert.equal(rpData.counts.problems, 0);
      assert.ok(rpData.pages[0].widgets.some(w => (w.text || '').includes('海岸田野笔记（迁移后编辑）')));
    });
  } finally {
    if (studio1) await studio1.close();
    if (studio2) await studio2.close();
    await closeInProcessStudioServer();
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test('P02: compatibility diagnostics report missing assets/fonts/tokens/components and preserve unknown future schema fields read-only', () => {
  const doc = importToStudioDocument({
    name: 'Diag Test',
    domain: 'web',
    tokens: { brand: '#112233' },
    pages: [
      {
        id: 'home',
        domain: 'web',
        root: {
          id: 'root',
          type: 'box',
          layout: 'column',
          w: 800,
          h: 600,
          children: [
            { id: 'img1', type: 'image', src: 'assets/missing-image.png', w: 200, h: 120 },
            { id: 'lbl1', type: 'label', text: '测试文本', fontFamily: 'MissingProprietaryFont', textColor: '$missingToken', w: 200, h: 32 },
            { id: 'inst1', type: 'instance', component: 'MissingComp', w: 200, h: 40 },
          ],
        },
      },
    ],
  });
  doc.fonts = {
    catalog: [{ family: 'MissingProprietaryFont', path: 'fonts/missing.woff2' }],
  };

  const report = buildBundleCompatibilityReport(doc, { projectDir: null });
  const codes = new Set(report.diagnostics.map(d => d.code));
  assert.ok(codes.has('W_ASSET_FILE_MISSING'));
  assert.ok(codes.has('W_FONT_FILE_MISSING'));
  assert.ok(codes.has('W_UNRESOLVED_TOKEN'));
  assert.ok(codes.has('E_MISSING_COMPONENT_DEFINITION'));
  assert.equal(report.portable, false);

  // Test forward schema version & unknown fields preservation
  const futureRawDoc = structuredClone(doc);
  futureRawDoc.schemaVersion = 99;
  futureRawDoc.futureTopLevelFeature = { mode: 'spatial-canvas', version: 2 };
  futureRawDoc.pages[0].root.children[1].futureNodeHint = 'shader-glow';

  const migration = migrateAndPreserveSchema(futureRawDoc);
  assert.equal(migration.migrated, true);
  assert.equal(migration.doc.readonlyUnknownFields.topLevel.futureTopLevelFeature.mode, 'spatial-canvas');
  assert.equal(migration.doc.pages[0].root.children[1]._readonlyPreservedFields.futureNodeHint, 'shader-glow');
  assert.ok(migration.diagnostics.some(d => d.code === 'W_SCHEMA_FORWARD_COMPAT'));
  assert.ok(migration.diagnostics.some(d => d.code === 'W_UNKNOWN_FIELDS_READONLY'));
});

test('M01: 3-way merge auto-merges independent human+AI edits into a single undoable transaction and detects all 8 conflict classes', { timeout: 45000 }, async () => {
  const workRoot = mkdtempSync(join(tmpdir(), 'studio-m01-merge-'));
  const projectDir = join(workRoot, 'project');
  const externalJsonPath = join(workRoot, 'external-spec.json');
  const externalRp1Path = join(workRoot, 'external-snippet.rp1');

  const initialSpec = createSampleSourceSpec('assets/cover-photo.png');
  mkdirSync(join(projectDir, 'assets'), { recursive: true });
  writeFileSync(join(projectDir, 'assets', 'cover-photo.png'), TINY_PNG);
  writeFileSync(externalJsonPath, JSON.stringify(initialSpec, null, 2), 'utf8');

  let studio = null;
  try {
    const started = await startStudioServer({
      projectDir,
      sourcePath: externalJsonPath,
      port: 0,
    });
    studio = started.studio;
    const baseRev = studio.store.appliedRevision;

    // 1. Human edits hero_title on canvas (advances store to rev 2)
    const humanEdit = await studioHandlers.studio_apply_commands({
      url: studio.url,
      baseRevision: baseRev,
      idempotencyKey: 'human-edit-title',
      actor: { role: 'human', clientId: 'web-canvas' },
      commands: [
        { type: 'setText', pageId: 'home', nodeId: 'hero_title', text: '人类修改后的主标题' },
      ],
    });
    assert.equal(humanEdit.ok, true);
    assert.equal(studio.store.appliedRevision, baseRev + 1);

    // 2. AI concurrently submits non-conflicting commands based on baseRev (edits toggle_btn + adds token)
    const previewRes = await studioHandlers.studio_merge_document({
      url: studio.url,
      mode: 'preview',
      baseRevision: baseRev,
      theirsCommands: [
        { type: 'setText', pageId: 'home', nodeId: 'toggle_btn', text: 'AI并发更新按钮' },
        { type: 'setToken', category: 'color', name: 'accent', value: '#059669' },
      ],
    });
    assert.equal(previewRes.ok, true);
    assert.equal(previewRes.canAutoApply, true);
    assert.equal(previewRes.conflictCount, 0);

    // Apply the 3-way merge
    const applyRes = await studioHandlers.studio_merge_document({
      url: studio.url,
      mode: 'apply',
      baseRevision: baseRev,
      idempotencyKey: 'merge-human-ai-1',
      previewHash: previewRes.previewHash,
      theirsCommands: [
        { type: 'setText', pageId: 'home', nodeId: 'toggle_btn', text: 'AI并发更新按钮' },
        { type: 'setToken', category: 'color', name: 'accent', value: '#059669' },
      ],
    });
    assert.equal(applyRes.ok, true, JSON.stringify(applyRes));
    assert.equal(applyRes.applied, true);

    // Verify both human and AI changes are present in store.doc
    const homeChildren = studio.store.doc.pages[0].root.children;
    assert.equal(homeChildren.find(n => n.id === 'hero_title').text, '人类修改后的主标题');
    assert.equal(homeChildren.find(n => n.id === 'toggle_btn').text, 'AI并发更新按钮');
    assert.equal(studio.store.doc.palette.accent, '#059669');
    assert.equal(studio.store.doc.tokens.colors.accent, '#059669');

    // Verify idempotent replay with same idempotencyKey
    const replayRes = await studioHandlers.studio_merge_document({
      url: studio.url,
      mode: 'apply',
      baseRevision: baseRev,
      idempotencyKey: 'merge-human-ai-1',
      theirsCommands: [
        { type: 'setText', pageId: 'home', nodeId: 'toggle_btn', text: 'AI并发更新按钮' },
        { type: 'setToken', category: 'color', name: 'accent', value: '#059669' },
      ],
    });
    assert.equal(replayRes.ok, true);
    assert.equal(replayRes.idempotentReplay, true);

    // Verify single-step undo reverts the merge transaction back to pre-merge state
    const undoRes = await studioHandlers.studio_undo({ url: studio.url });
    assert.equal(undoRes.ok, true);
    assert.equal(studio.store.doc.pages[0].root.children.find(n => n.id === 'toggle_btn').text, '展开详情');
    assert.equal(studio.store.doc.pages[0].root.children.find(n => n.id === 'hero_title').text, '人类修改后的主标题');

    // Redo restores the merge transaction
    const redoRes = await studioHandlers.studio_redo({ url: studio.url });
    assert.equal(redoRes.ok, true);
    assert.equal(studio.store.doc.pages[0].root.children.find(n => n.id === 'toggle_btn').text, 'AI并发更新按钮');

    // 3. Verify all conflict classes in mergeStudioDocuments
    const baseDoc = structuredClone(studio.store.doc);
    // Ensure a stack container with a positioned child exists in baseDoc for layout coupling tests
    baseDoc.pages[0].root.children.push({
      id: 'free_stage',
      type: 'box',
      layout: 'stack',
      x: 0,
      y: 0,
      w: 350,
      h: 200,
      children: [
        { id: 'floating_tag', type: 'label', text: '浮动标签', x: 20, y: 20, w: 100, h: 28 },
        { id: 'movable_chip', type: 'label', text: '可移标签', x: 20, y: 60, w: 100, h: 28 },
      ],
    });

    const oursDoc = structuredClone(baseDoc);
    const theirsDoc = structuredClone(baseDoc);

    // (a) same-field conflict on hero_title.text
    oursDoc.pages[0].root.children.find(n => n.id === 'hero_title').text = 'Ours 标题';
    theirsDoc.pages[0].root.children.find(n => n.id === 'hero_title').text = 'Theirs 标题';

    // (b) delete-modify conflict on detail_panel
    oursDoc.pages[0].root.children = oursDoc.pages[0].root.children.filter(n => n.id !== 'detail_panel');
    theirsDoc.pages[0].root.children.find(n => n.id === 'detail_panel').text = 'Theirs 修改了被删节点';

    // (c) layout-coupled conflict on floating_tag (ours changes x, theirs changes right)
    const oursStage = oursDoc.pages[0].root.children.find(n => n.id === 'free_stage');
    const theirsStage = theirsDoc.pages[0].root.children.find(n => n.id === 'free_stage');
    oursStage.children.find(n => n.id === 'floating_tag').x = 48;
    theirsStage.children.find(n => n.id === 'floating_tag').right = 16;

    // (d) parent-child-layout-coupled conflict (ours changes free_stage layout to column, theirs changes movable_chip.y)
    oursStage.layout = 'column';
    theirsStage.children.find(n => n.id === 'movable_chip').y = 110;

    // (e) component-instance-coupled conflict (ours edits InfoBadge definition, theirs edits badge_inst overrides)
    oursDoc.components.InfoBadge.root.fill = '#DBEAFE';
    theirsDoc.pages[0].root.children.find(n => n.id === 'badge_inst').overrides = {
      badge_label: { text: 'Theirs 覆盖文字' },
    };

    // (f) reference-coupled conflict (ours deletes token $brand, theirs references $brand on floating_tag.color)
    delete oursDoc.tokens.brand;
    if (oursDoc.tokens.colors) delete oursDoc.tokens.colors.brand;
    if (oursDoc.palette) delete oursDoc.palette.brand;
    theirsStage.children.find(n => n.id === 'floating_tag').color = '$brand';

    const conflictMerge = mergeStudioDocuments({
      baseDoc,
      oursDoc,
      theirsDoc,
      prefer: 'fail',
    });
    assert.equal(conflictMerge.canAutoApply, false);
    const conflictTypes = new Set(conflictMerge.conflicts.map(c => c.type));
    assert.ok(conflictTypes.has('same-field'), `missing same-field in ${[...conflictTypes]}`);
    assert.ok(conflictTypes.has('delete-modify'), `missing delete-modify in ${[...conflictTypes]}`);
    assert.ok(conflictTypes.has('layout-coupled'), `missing layout-coupled in ${[...conflictTypes]}`);
    assert.ok(conflictTypes.has('parent-child-layout-coupled'), `missing parent-child-layout-coupled in ${[...conflictTypes]}`);
    assert.ok(conflictTypes.has('component-instance-coupled'), `missing component-instance-coupled in ${[...conflictTypes]}`);
    assert.ok(conflictTypes.has('reference-coupled'), `missing reference-coupled in ${[...conflictTypes]}`);

    // Verify explicit resolution works
    const resolvedMerge = mergeStudioDocuments({
      baseDoc,
      oursDoc,
      theirsDoc,
      prefer: 'theirs',
      resolutions: {
        'node:home/hero_title:text': 'ours',
      },
    });
    assert.equal(resolvedMerge.canAutoApply, true);
    assert.equal(resolvedMerge.unresolvedCount, 0);
    assert.equal(
      resolvedMerge.mergedDoc.pages[0].root.children.find(n => n.id === 'hero_title').text,
      'Ours 标题',
    );
    assert.equal(
      resolvedMerge.mergedDoc.pages[0].root.children.find(n => n.id === 'detail_panel').text,
      'Theirs 修改了被删节点',
    );

    // 4. External file change detection (check-external) does NOT silently overwrite authority
    writeFileSync(
      externalRp1Path,
      'button #toggle_btn "外部RP1文件修改按钮"',
      'utf8',
    );
    const beforeHash = studio.store.doc.contentHash;
    const extCheck = await studioHandlers.studio_merge_document({
      url: studio.url,
      mode: 'check-external',
      baseRevision: studio.store.appliedRevision,
      externalSourcePath: externalRp1Path,
      theirsPageId: 'home',
      theirsSourceMode: 'update',
    });
    assert.equal(extCheck.ok, true);
    assert.equal(extCheck.authorityPreserved, true);
    assert.equal(studio.store.doc.contentHash, beforeHash);
  } finally {
    if (studio) await studio.close();
    await closeInProcessStudioServer();
    rmSync(workRoot, { recursive: true, force: true });
  }
});
