#!/usr/bin/env node
// proto.mjs v3.0 全量回归测试：
// 1. 词法原子保护 + CJK 避头尾 (Kinsoku Shori) 断行引擎
// 2. PingFang.ttc 零墨水高度缺字检测器 (no_missing_glyphs)
// 3. 1:1 代理-宿主水平文本内边距校准 (bg-box-* + 10px inset)
// 4. 完整原语契约 (button / input / divider / badge / card / label size&weight&content 别名)
// 5. 零静默失败 Schema 校验器 (未知 type 报错 + 未知属性近似建议)
// 6. 自动同行等高卡片求解器 + 2D 容器溢出/兄弟碰撞证明器 (no_container_overflow / no_box_overlap)
// 运行：node test/proto-v21-check.mjs
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PROTO = join(ROOT, 'scripts', 'proto.mjs');
const LAB = join(ROOT, 'examples', 'lab-mobile-lowfi.proto.json');
const INTERACTIVE = join(ROOT, 'examples', 'mobile-lostfound.proto.json');

let passed = 0, failed = 0;
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name} ${detail}`); }
}
function compile(specPath, outDir, extra = [], allowFail = false) {
  const r = spawnSync(process.execPath, [PROTO, 'compile', '--spec', specPath, '--out-dir', outDir, ...extra], {
    encoding: 'utf8',
  });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`compile failed: ${r.stderr || r.stdout}`);
  }
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    audit: JSON.parse(readFileSync(join(outDir, 'audit-report.json'), 'utf8')),
    plan: JSON.parse(readFileSync(join(outDir, 'compile-plan.json'), 'utf8')),
  };
}
function findPage(plan, key) {
  return plan.pages.find(p => p.slug === key);
}

const tmp = mkdtempSync(join(tmpdir(), 'proto-v30-check-'));
try {
  // 1) 课设静态模板：button 原语 + 词法断行 + 避头尾 + 零缺字 + 1:1 左内边距
  const labOut = join(tmp, 'lab');
  const lab = compile(LAB, labOut);
  ok('课设模板 compile/audit 通过', lab.audit.ok === true, JSON.stringify(lab.audit.gates || {}));
  ok('课设模板 static=true', lab.audit.static === true && lab.plan.static === true);
  ok('课设模板 3 页', lab.plan.pageCount === 3, String(lab.plan.pageCount));
  const p3spec = JSON.parse(readFileSync(join(labOut, 'page3-spec-doc.spec.json'), 'utf8'));
  const p3children = p3spec.frames[0].children;
  const p3names = new Set(p3children.map(c => c.name));
  const p3byName = Object.fromEntries(p3children.map(c => [c.name, c]));
  ok('button 原语已发射（doc-tag-1/2/3）', ['doc-tag-1', 'doc-tag-2', 'doc-tag-3'].every(n => p3names.has(n)));
  ok('说明页设计说明已存在（doc-para-design-l1）', p3names.has('doc-para-design-l1'));
  ok('说明页思考点已存在（doc-think-1-l1）', p3names.has('doc-think-1-l1'));
  ok('说明页无文本裁切', lab.audit.metrics.text_clip_count === 0);
  ok('静态模板交互为 0', findPage(lab.plan, 'page1-browse').interactions.length === 0);

  // 2) v3.0 词法原子保护与 CJK 避头尾 (Kinsoku Shori) 验证
  const specLines = p3children.filter(c => c.name.startsWith('doc-para-spec-l')).map(c => c.text);
  ok('英文词法原子保护：Home Indicator 绝不被拦腰劈成 Home In + dicator',
    specLines.some(ln => ln.includes('Indicator')) && !specLines.some(ln => /^dicator\b/.test(ln.trim())),
    JSON.stringify(specLines));
  const qaLines = p3children.filter(c => c.name.startsWith('doc-para-qa-l')).map(c => c.text);
  ok('CJK 避头尾保护：全角冒号「：」绝不孤立在行首',
    qaLines.every(ln => !/^[：，。、；！？）]/.test(ln.trim())),
    JSON.stringify(qaLines));
  ok('说明页 kinsoku_violation_count === 0',
    findPage(lab.plan, 'page3-spec-doc').audit.metrics.kinsoku_violation_count === 0);
  ok('说明页 missing_glyph_count === 0（无 U+2713 零高度空白缩进）',
    findPage(lab.plan, 'page3-spec-doc').audit.metrics.missing_glyph_count === 0);
  ok('说明页三列卡片省去显式 h 后自动等高对齐 (520px)',
    p3byName['bg-doc-col-1']?.h === 520 && p3byName['bg-doc-col-2']?.h === 520 && p3byName['bg-doc-col-3']?.h === 520);

  // 3) v3.0 代理-宿主 1:1 左对齐输入框水平内边距 (10px inset) 验证
  const p2pubSpec = JSON.parse(readFileSync(join(labOut, 'states', 'page2-detail-panel__panel-item-state__pub.spec.json'), 'utf8'));
  const pubMap = Object.fromEntries(p2pubSpec.frames[0].children.map(c => [c.name, c]));
  ok('发布态左对齐输入框生成独立背景矩形 bg-box-pub-inp-name', Boolean(pubMap['bg-box-pub-inp-name']));
  ok('发布态左对齐输入框文本相比边框左内缩 10px（杜绝宿主贴边）',
    pubMap['pub-inp-name']?.x - pubMap['bg-box-pub-inp-name']?.x === 10,
    `txt.x=${pubMap['pub-inp-name']?.x}, bg.x=${pubMap['bg-box-pub-inp-name']?.x}`);

  // 4) bindDetail + expandStates：4 卡 → 5 面板状态 / 4+1 交互
  const bindingSpecPath = join(tmp, 'binding.proto.json');
  const bindingSpec = JSON.parse(readFileSync(LAB, 'utf8'));
  bindingSpec.static = false;
  bindingSpec.name = 'bindDetail-check';
  for (const ch of bindingSpec.pages[0].root.children) {
    if (ch.type === 'mobile-card-list') ch.bindDetail.expandStates = true;
  }
  writeFileSync(bindingSpecPath, JSON.stringify(bindingSpec, null, 1));
  const bindOut = join(tmp, 'binding');
  const binding = compile(bindingSpecPath, bindOut);
  const p1 = findPage(binding.plan, 'page1-browse');
  const p2 = findPage(binding.plan, 'page2-detail-panel');
  ok('bindDetail 编译审计通过', binding.audit.ok === true, JSON.stringify(binding.audit.warnings));
  ok('bindDetail 生成 4 个卡片交互', p1.interactions.length === 4, String(p1.interactions.length));
  ok('bindDetail 生成 5 个详情状态', p2.dynamicPanels[0]?.states.length === 5, String(p2.dynamicPanels[0]?.states.length));
  ok('bindDetail 生成 OnPageLoad 条件分支', (p2.interactions || []).some(ix => ix.trigger === 'page'));
  const onload = (p2.interactions || []).find(ix => ix.trigger === 'page');
  const cases = onload?.events?.[0]?.cases || [];
  ok('OnPageLoad 4 个 else-if 分支', cases.length === 4 && cases[0].condition === 'if' && cases.slice(1).every(c => c.condition === 'else-if'));

  // 5) --no-interactions 静态覆盖
  const staticOut = join(tmp, 'static');
  const staticRes = compile(INTERACTIVE, staticOut, ['--no-interactions']);
  ok('--no-interactions 覆盖为 static=true', staticRes.plan.static === true);
  ok('--no-interactions 所有页 interactions=0', staticRes.plan.pages.every(p => (p.interactions || []).length === 0));
  ok('--no-interactions 审计通过', staticRes.audit.ok === true);

  // 6) v3.0 完整原语契约测试：input / native input / divider / badge / card / label(size,weight,content) + 同行自动等高
  const primSpecPath = join(tmp, 'primitives.proto.json');
  const primSpec = {
    name: 'v30-primitives-check',
    theme: 'mobile-lowfi',
    static: true,
    pages: [{
      name: '原语页',
      slug: 'prim-page',
      canvas: { w: 600, h: 480 },
      root: {
        type: 'box',
        name: 'grp-prim-root',
        layout: 'column',
        w: 600,
        h: 480,
        padding: 16,
        gap: 12,
        fill: '$bg',
        isGroup: true,
        children: [
          { type: 'label', name: 'lbl-alias', content: '别名属性测试标题', size: 18, weight: 700, color: '$ink' },
          { type: 'input', name: 'inp-wire', placeholder: '请输入搜索词', w: 260, h: 36 },
          { type: 'input', name: 'inp-real', native: true, placeholder: '原生输入框', w: 260, h: 36 },
          { type: 'divider', name: 'div-line', w: 568, h: 1 },
          { type: 'badge', name: 'bdg-status', text: '已核验', w: 72, h: 24 },
          {
            type: 'box',
            name: 'grp-equal-row',
            layout: 'row',
            w: 568,
            gap: 16,
            isGroup: true,
            children: [
              {
                type: 'card',
                name: 'crd-short',
                flex: 1,
                children: [
                  { type: 'label', name: 'lbl-s1', text: '短卡片标题', size: 14, weight: 600 },
                ],
              },
              {
                type: 'card',
                name: 'crd-tall',
                flex: 1,
                children: [
                  { type: 'label', name: 'lbl-t1', text: '高卡片第一行', size: 14, weight: 600 },
                  { type: 'label', name: 'lbl-t2', text: '高卡片第二行', size: 12, weight: 400 },
                  { type: 'label', name: 'lbl-t3', text: '高卡片第三行', size: 12, weight: 400 },
                ],
              },
            ],
          },
        ],
      },
    }],
  };
  writeFileSync(primSpecPath, JSON.stringify(primSpec, null, 2));
  const primOut = join(tmp, 'prim-out');
  const primRes = compile(primSpecPath, primOut);
  const primChildren = JSON.parse(readFileSync(join(primOut, 'prim-page.spec.json'), 'utf8')).frames[0].children;
  const primMap = Object.fromEntries(primChildren.map(c => [c.name, c]));
  ok('原语契约编译通过', primRes.audit.ok === true, JSON.stringify(primRes.audit.gates));
  ok('label 别名 content/size/weight 生效', primMap['lbl-alias']?.text === '别名属性测试标题' && primMap['lbl-alias']?.size === 18 && primMap['lbl-alias']?.weight === 700);
  ok('input 原语不再静默丢失（生成 inp-wire 与 bg-box-inp-wire）', Boolean(primMap['inp-wire'] && primMap['bg-box-inp-wire']));
  ok('input(native:true) 注册到 nativeInputs', primRes.plan.nativeInputs.some(n => n.name === 'inp-real'));
  ok('divider 原语生成 1px 分割线', primMap['div-line']?.h === 1 && primMap['div-line']?.w === 568);
  ok('badge 原语生成胶囊标签', primMap['bdg-status']?.text === '已核验');
  ok('card 原语与同行自动等高求解器生效（短卡片自动拉伸至高卡片高度）',
    primMap['bg-crd-short']?.h > 0 && primMap['bg-crd-short']?.h === primMap['bg-crd-tall']?.h,
    `short.h=${primMap['bg-crd-short']?.h}, tall.h=${primMap['bg-crd-tall']?.h}`);

  // 7) v3.0 零静默失败：未知组件 type 必须报错并给出拼写建议
  const badTypePath = join(tmp, 'bad-type.proto.json');
  writeFileSync(badTypePath, JSON.stringify({
    name: 'bad-type',
    pages: [{
      name: 'P1',
      slug: 'p1',
      canvas: { w: 375, h: 400 },
      root: { type: 'box', name: 'r', w: 375, h: 400, isGroup: true, children: [{ type: 'buton', name: 'b1', text: '错别字按钮' }] },
    }],
  }));
  const badTypeRun = spawnSync(process.execPath, [PROTO, 'compile', '--spec', badTypePath, '--out-dir', join(tmp, 'bad-type-out')], { encoding: 'utf8' });
  ok('未知组件 type (buton) 拒绝静默忽略并立即报错退出', badTypeRun.status !== 0);
  ok('未知组件 type 错误消息包含近似拼写建议 Did you mean: button', (badTypeRun.stderr + badTypeRun.stdout).includes('button'));

  // 8) v3.0 缺字检测门禁与容器溢出门禁负向拦截测试
  const negPath = join(tmp, 'neg.proto.json');
  writeFileSync(negPath, JSON.stringify({
    name: 'neg-check',
    theme: 'mobile-lowfi',
    static: true,
    pages: [{
      name: '负向检测页',
      slug: 'neg-page',
      canvas: { w: 375, h: 300 },
      root: {
        type: 'box',
        name: 'grp-neg-root',
        layout: 'column',
        w: 375,
        h: 300,
        padding: 16,
        gap: 8,
        fill: '$bg',
        isGroup: true,
        children: [
          { type: 'label', name: 'lbl-bad-glyph', text: '✓ 含零墨水高度字符', size: 12, weight: 600, fontSiz: 12 },
          {
            type: 'box',
            name: 'grp-small-box',
            layout: 'column',
            w: 120,
            h: 40,
            fill: '$surface',
            isGroup: true,
            children: [
              { type: 'button', name: 'btn-overflow-child', text: '超宽子元件', w: 260, h: 36 },
            ],
          },
        ],
      },
    }],
  }));
  const negRes = compile(negPath, join(tmp, 'neg-out'), [], true);
  ok('零墨水高度字符 ✓ 被 no_missing_glyphs 门禁精准拦截',
    negRes.audit.structural_gates.no_missing_glyphs === false && negRes.audit.metrics.missing_glyph_count === 1);
  ok('子元件超出父容器边界被 no_container_overflow 门禁精准拦截',
    negRes.audit.structural_gates.no_container_overflow === false && negRes.audit.metrics.container_overflow_count >= 1);
  ok('未知属性名 fontSiz 触发近似属性建议告警',
    negRes.audit.warnings.some(w => w.includes('WARN_UNKNOWN_PROP') && w.includes('fontSize')));

  // 9) v3.5 (P0-2) 尺寸语义与 Grid 布局真几何契约测试（w/h:"fill"|"hug"|"auto" + flex 共存 + 叶子节点 fill + layout:"grid"）
  const sizingSpecPath = join(tmp, 'sizing-grid.proto.json');
  writeFileSync(sizingSpecPath, JSON.stringify({
    name: 'v35-sizing-grid-check',
    domain: 'web',
    theme: 'cobalt-pro',
    static: true,
    pages: [{
      name: '尺寸与网格页',
      slug: 'sizing-page',
      canvas: { w: 600, h: 640 },
      root: {
        type: 'box',
        name: 'grp-sizing-root',
        layout: 'column',
        w: 600,
        h: 640,
        padding: 16,
        gap: 16,
        fill: '$bg',
        isGroup: true,
        children: [
          // 9.1: column 下 box w:"fill" -> 600 - 32 = 568
          {
            type: 'box',
            name: 'grp-col-fill-box',
            layout: 'row',
            w: 'fill',
            h: 64,
            padding: 8,
            gap: 16,
            fill: '$surface',
            bgName: 'bg-col-fill-box',
            isGroup: true,
            children: [
              // 9.2: row 下 w:"fill" 与 flex:1 共存均分 (568 - 16 - 16)/2 = 268，且交叉轴 h:"fill" -> 64 - 16 = 48
              { type: 'box', name: 'grp-row-wfill', w: 'fill', h: 'fill', fill: '$surface2', bgName: 'bg-row-wfill', isGroup: true, children: [{ type: 'label', name: 'lbl-wf', text: 'w:fill', w: 'fill' }] },
              { type: 'box', name: 'grp-row-flex1', flex: 1, h: 'fill', fill: '$surface2', bgName: 'bg-row-flex1', isGroup: true, children: [{ type: 'label', name: 'lbl-fx', text: 'flex:1', w: 'fill' }] },
            ],
          },
          // 9.3: box w:"hug" h:"hug" 包裹 120x32 按钮 + padding 8 -> 136x48
          {
            type: 'box',
            name: 'grp-hug-box',
            layout: 'column',
            w: 'hug',
            h: 'hug',
            padding: 8,
            fill: '$surface',
            bgName: 'bg-hug-box',
            isGroup: true,
            children: [
              { type: 'button', name: 'btn-inside-hug', text: '自适应按钮', w: 120, h: 32 },
            ],
          },
          // 9.4: 叶子原语 (button / input / divider) 在 column 下支持 w:"fill" -> 568
          { type: 'button', name: 'btn-leaf-fill', text: '通栏按钮', w: 'fill', h: 36 },
          { type: 'input', name: 'inp-leaf-fill', placeholder: '通栏输入框', w: 'fill', h: 36 },
          { type: 'divider', name: 'div-leaf-fill', w: 'fill', h: 1 },
          // 9.5: layout:"grid" columns:3 gap:16 w:"fill"(568) padding:16 -> 内部宽 536，(536 - 32)/3 = 168
          {
            type: 'box',
            name: 'grp-grid-3col',
            layout: 'grid',
            columns: 3,
            gap: 16,
            padding: 16,
            w: 'fill',
            h: 'hug',
            fill: '$surface',
            bgName: 'bg-grid-3col',
            isGroup: true,
            children: [
              { type: 'button', name: 'btn-g1', text: '网格1', h: 36 },
              { type: 'button', name: 'btn-g2', text: '网格2', h: 36 },
              { type: 'button', name: 'btn-g3', text: '网格3', h: 36 },
              { type: 'button', name: 'btn-g4', text: '网格4', h: 36 },
              { type: 'button', name: 'btn-g5', text: '网格5', h: 36 },
              { type: 'button', name: 'btn-g6', text: '网格6', h: 36 },
            ],
          },
        ],
      },
    }],
  }, null, 2));
  const sizingOut = join(tmp, 'sizing-out');
  const sizingRes = compile(sizingSpecPath, sizingOut);
  const szChildren = JSON.parse(readFileSync(join(sizingOut, 'sizing-page.spec.json'), 'utf8')).frames[0].children;
  const szMap = Object.fromEntries(szChildren.map(c => [c.name, c]));
  ok('P0-2 sizing+grid 全量编译与门禁通过 (exit 0)', sizingRes.audit.ok === true, JSON.stringify(sizingRes.audit.gates));
  ok('P0-2 column 下 box w:"fill" 精确撑满父容器内宽 (568px)', szMap['bg-col-fill-box']?.w === 568, `w=${szMap['bg-col-fill-box']?.w}`);
  ok('P0-2 row 下 w:"fill" 与 flex:1 共存等宽均分 (268px vs 268px)',
    szMap['bg-row-wfill']?.w === 268 && szMap['bg-row-flex1']?.w === 268,
    `wfill=${szMap['bg-row-wfill']?.w}, flex1=${szMap['bg-row-flex1']?.w}`);
  ok('P0-2 row 下交叉轴 h:"fill" 精确撑满父容器内高 (48px)',
    szMap['bg-row-wfill']?.h === 48 && szMap['bg-row-flex1']?.h === 48,
    `h=${szMap['bg-row-wfill']?.h}`);
  ok('P0-2 box w:"hug" / h:"hug" 精确包裹子元件 + padding (136x48)',
    szMap['bg-hug-box']?.w === 136 && szMap['bg-hug-box']?.h === 48,
    `w=${szMap['bg-hug-box']?.w}, h=${szMap['bg-hug-box']?.h}`);
  ok('P0-2 叶子原语 button/input/divider 支持 w:"fill" (568px)',
    szMap['btn-leaf-fill']?.w === 568 && szMap['bg-box-inp-leaf-fill']?.w === 568 && szMap['div-leaf-fill']?.w === 568);
  ok('P0-2 layout:"grid" columns:3 自动换行与列宽/行距精确求解',
    szMap['btn-g1']?.w === 168 && szMap['btn-g2']?.x - szMap['btn-g1']?.x === 184 && szMap['btn-g4']?.x === szMap['btn-g1']?.x && szMap['btn-g4']?.y - szMap['btn-g1']?.y === 52,
    JSON.stringify({ g1: szMap['btn-g1'], g2: szMap['btn-g2'], g4: szMap['btn-g4'] }));

  // 10) v3.5 (P0-3) dump-spec --preset web-dashboard 导出 + 编译 + 审计全绿闭环
  const webDashJson = join(tmp, 'web-dashboard-dump.proto.json');
  const dumpRun = spawnSync(process.execPath, [PROTO, 'dump-spec', '--preset', 'web-dashboard', '-o', webDashJson], { encoding: 'utf8' });
  ok('P0-3 dump-spec --preset web-dashboard 导出成功 (exit 0)', dumpRun.status === 0);
  const webDashOut = join(tmp, 'web-dashboard-out');
  const webDashRes = compile(webDashJson, webDashOut);
  ok('P0-3 web-dashboard 导出 JSON 编译与四态/美学/结构门禁全绿 (exit 0, warnings=0)',
    webDashRes.status === 0 && webDashRes.audit.ok === true && webDashRes.audit.gates.four_state_ok === true && webDashRes.audit.warnings.length === 0,
    JSON.stringify({ gates: webDashRes.audit.gates, warnings: webDashRes.audit.warnings }));

  // 11) v3.5 (P3-1) 全部 10 项 structural_gates 均写入结构化 failures[]
  const failGates = new Set((negRes.audit.failures || []).map(f => f.gate));
  ok('P3-1 负向检测页 failures[] 包含结构化 no_missing_glyphs 与 no_container_overflow 条目',
    failGates.has('no_missing_glyphs') && failGates.has('no_container_overflow'),
    JSON.stringify(negRes.audit.failures));
  // 通过 audit_prototype 对全部 10 项结构门禁逐一触发，确认 10/10 门禁均产出结构化 failures[] 条目
  const tenGatesOut = execFileSync('python3', ['-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(join(ROOT, 'scripts'))})
import proto

root = {
  "type": "box", "name": "w1", "layout": "row", "isGroup": False,
  "_x": 0, "_y": 0, "_w": 375, "_h": 300,
  "children": [
    {"type": "shape-text", "name": "w1", "_x": 10, "_y": 10, "_w": 120, "_h": 36},
    {"type": "shape-text", "name": "w2", "_x": 40, "_y": 15, "_w": 400, "_h": 36},
  ]
}
emitted = {
  "flatChildren": [
    {"kind": "rect", "name": "w1", "x": 10, "y": 10, "w": 60, "h": 28, "fill": "#FFFFFF", "stroke": "#D9D9D9", "radius": 4, "text": "✓ 超长裁切文字测试按钮一二三四五六", "size": 14, "weight": 600, "color": "#262626", "align": "center", "inModal": False},
    {"kind": "text", "name": "doc-para-l2", "x": 20, "y": 12, "w": 220, "h": 28, "text": "：行首避头违例文字", "size": 14, "weight": 600, "color": "#262626", "align": "left", "inModal": False},
  ],
  "axvg": {
    "scene": {
      "items": [{
        "scene": {
          "items": [
            {"itemType": 1, "name": "w1", "isNameDynamic": False},
            {"itemType": 1, "name": "w1", "isNameDynamic": False},
            {"itemType": 1, "name": "w2", "isNameDynamic": False},
          ]
        }
      }]
    }
  }
}
plan = {
  "domain": "mobile", "theme": "mobile-lowfi",
  "allMainWidgets": [{"name": "w1"}, {"name": "w2"}],
  "dynamicPanels": [], "nativeInputs": [], "knownPageNames": ["P1"],
  "interactions": [{
    "trigger": "w1",
    "events": [{"name": "OnClick", "cases": [{"actions": [{"type": "set-panel-state", "target": "dangling-panel"}]}]}]
  }]
}
rep = proto.audit_prototype(root, emitted, plan)
gates_in_failures = sorted(list({f["gate"] for f in rep["failures"]}))
print(json.dumps({"gates": gates_in_failures, "count": len(gates_in_failures)}))
`], { encoding: 'utf8' });
  const tenGatesRes = JSON.parse(tenGatesOut.trim());
  const expected10Gates = [
    'group_coverage_ok', 'interaction_targets_ok', 'no_box_overlap',
    'no_container_overflow', 'no_duplicate_names', 'no_kinsoku_violation',
    'no_missing_glyphs', 'no_text_clip', 'no_text_overlap', 'semantic_naming_ok',
  ];
  ok('P3-1 全部 10 项 structural_gates 100% 产出结构化 failures[] 条目 (10/10)',
    expected10Gates.every(g => tenGatesRes.gates.includes(g)),
    JSON.stringify(tenGatesRes));

  // 12) v3.5 (P3-2) 多页 metrics 按画板面积/检查数加权聚合 + whitespace_ratio_range
  const labPageAreas = lab.audit.pages.map(p => p.metrics.canvas_area);
  const labPageWs = lab.audit.pages.map(p => p.metrics.whitespace_ratio_pct);
  const expectedWeightedWs = Math.round((labPageAreas.reduce((s, a, i) => s + a * labPageWs[i], 0) / labPageAreas.reduce((s, a) => s + a, 0)) * 10) / 10;
  ok('P3-2 多页 whitespace_ratio_pct 按画板面积加权（而非简单算术平均）且输出 whitespace_ratio_range',
    Math.abs(lab.audit.metrics.whitespace_ratio_pct - expectedWeightedWs) <= 0.1
      && Array.isArray(lab.audit.metrics.whitespace_ratio_range)
      && lab.audit.metrics.whitespace_ratio_range.length === 2,
    `got=${lab.audit.metrics.whitespace_ratio_pct}, expected=${expectedWeightedWs}, range=${JSON.stringify(lab.audit.metrics.whitespace_ratio_range)}`);

  // 13) v3.5 Knuth-Plass 动态规划全局最优断行 vs Greedy 贪心断行对比验证
  const kpCheckOut = execFileSync('python3', ['-c', `
import json, sys
sys.path.insert(0, ${JSON.stringify(join(ROOT, 'scripts'))})
import proto

sample = "本页采用声明式布局引擎与动态规划断行算法，结合 Web-Dashboard-Configuration 组件体系实现均衡排版。"
max_w = 180.0
greedy_lines = proto.wrap_text_greedy(sample, max_w, 12, False)
dp_lines = proto.wrap_text(sample, max_w, 12, False, mode="knuth-plass")
g_cost = proto.measure_paragraph_raggedness(greedy_lines, max_w, 12, False)
dp_cost = proto.measure_paragraph_raggedness(dp_lines, max_w, 12, False)
print(json.dumps({
  "greedy_lines": greedy_lines,
  "dp_lines": dp_lines,
  "greedy_cost": round(g_cost, 2),
  "dp_cost": round(dp_cost, 2),
  "dp_no_orphan": len(dp_lines[-1].strip()) >= 2,
  "chars_preserved": "".join(t.strip() for t in greedy_lines) == "".join(t.strip() for t in dp_lines),
}, ensure_ascii=False))
`], { encoding: 'utf8' });
  const kpRes = JSON.parse(kpCheckOut.trim());
  ok('Knuth-Plass DP 最优断行平方参差度代价值严格优于 Greedy 贪心断行且消除孤字行',
    kpRes.dp_cost < kpRes.greedy_cost && kpRes.dp_no_orphan && kpRes.chars_preserved,
    JSON.stringify(kpRes));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
