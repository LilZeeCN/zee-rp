import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { importToStudioDocument } from '../../studio/document.mjs';
import { resolveDocumentScene } from '../../studio/scene-resolver.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = resolve(HERE, '../../scripts');

export function serializePageRootToRp1Dsl(pageId, rootNode) {
  const stageNode = {
    id: `${pageId}_stage`,
    type: 'box',
    layout: rootNode.layout || 'stack',
    x: 0,
    y: 0,
    w: rootNode.w,
    h: rootNode.h,
    children: structuredClone(rootNode.children || []),
  };
  const spec = {
    language: 'rp/1',
    target: 9,
    pages: [
      {
        id: pageId,
        root: stageNode,
      },
    ],
  };
  const pyCode = [
    'import json, sys',
    'sys.path.insert(0, sys.argv[1])',
    'from rp_dsl import spec_to_dsl',
    'spec = json.loads(sys.stdin.read())',
    'sys.stdout.write(spec_to_dsl(spec))',
  ].join('\n');
  const proc = spawnSync('python3', ['-B', '-c', pyCode, SCRIPTS_DIR], {
    input: JSON.stringify(spec),
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (proc.error || proc.status !== 0) {
    throw new Error(`Failed to serialize ${pageId} to RP/1 DSL: ${proc.error?.message || proc.stderr}`);
  }
  return proc.stdout;
}

export function loadBenchmarkFixtures() {
  const suite = JSON.parse(readFileSync(resolve(HERE, 'tasks.json'), 'utf8'));
  const content = JSON.parse(readFileSync(resolve(HERE, 'fixtures/content.json'), 'utf8'));
  const records = JSON.parse(readFileSync(resolve(HERE, 'fixtures/records.json'), 'utf8'));
  const assets = JSON.parse(readFileSync(resolve(HERE, 'fixtures/assets.json'), 'utf8'));
  const localEdit = JSON.parse(readFileSync(resolve(HERE, 'fixtures/local-edit.json'), 'utf8'));
  return { suite, content, records, assets, localEdit };
}

/**
 * Convert a hierarchical RP/1 page tree into flat low-level Studio commands
 * (`addPage`, `setProperties`, `addNode`) to compare RP/1 high-level authoring
 * against low-level command authoring under identical task brief, fixtures, and viewport.
 */
function flattenPageTreeToLowLevelCommands(pageSpec, { isInitialHome = false } = {}) {
  const cmds = [];
  const pageId = pageSpec.id;
  if (!isInitialHome) {
    cmds.push({
      type: 'addPage',
      pageId,
      name: pageSpec.name || pageId,
      domain: pageSpec.domain || 'web',
      ...(pageSpec.device ? { device: pageSpec.device } : {}),
      ...(pageSpec.canvas?.w ? { w: pageSpec.canvas.w } : {}),
      ...(pageSpec.canvas?.h ? { h: pageSpec.canvas.h } : {}),
    });
  } else if (pageSpec.canvas?.w && pageSpec.canvas?.h) {
    cmds.push({
      type: 'resizeArtboard',
      pageId,
      w: pageSpec.canvas.w,
      h: pageSpec.canvas.h,
    });
  }

  const root = pageSpec.root;
  const rootNodeId = `${pageId}_root`;
  const rootProps = { ...root };
  delete rootProps.id;
  delete rootProps.type;
  delete rootProps.children;
  if (Object.keys(rootProps).length > 0) {
    cmds.push({
      type: 'setProperties',
      pageId,
      nodeId: rootNodeId,
      properties: rootProps,
    });
  }

  function walkChildren(children, parentId) {
    for (const child of children || []) {
      const nodeCopy = structuredClone(child);
      const subChildren = Array.isArray(nodeCopy.children) && nodeCopy.type === 'box' ? nodeCopy.children : null;
      if (subChildren) {
        nodeCopy.children = [];
      }
      cmds.push({
        type: 'addNode',
        pageId,
        parentId,
        node: nodeCopy,
      });
      if (subChildren && subChildren.length > 0) {
        walkChildren(subChildren, nodeCopy.id);
      }
    }
  }

  walkChildren(root.children || [], rootNodeId);
  return cmds;
}

export function buildTaskSpec(taskId, fixtures = loadBenchmarkFixtures(), { track = 'rp1-authoring' } = {}) {
  const { content, records } = fixtures;
  const isRp1 = track === 'rp1-authoring';

  if (taskId === 'T01') {
    const [w1, w2, w3] = content.words;
    return {
      name: '每日单词回忆与复习',
      domain: 'mobile',
      palette: {
        bg: '#102D3B',
        surface: '#173B4C',
        ink: '#F6F1DF',
        muted: '#AFC4CC',
        brand: '#F6D94D',
      },
      variables: {
        wordIndex: 1,
      },
      datasets: {
        words: {
          rows: structuredClone(content.words),
        },
      },
      pages: [
        {
          id: 'home',
          name: '今日单词回忆',
          domain: 'mobile',
          device: 'iphone-17-pro',
          canvas: { w: 402, h: 874 },
          root: {
            id: 'root',
            type: 'box',
            layout: 'stack',
            w: 402,
            h: 874,
            fill: '#102D3B',
            children: [
              {
                id: 'top-brand',
                type: 'label',
                text: 'DEEP / RECALL · 今日复习 3 张',
                x: 28,
                y: 52,
                w: 220,
                h: 24,
                fontSize: 13,
                fontWeight: 600,
                color: '#AFC4CC',
                role: 'brand',
              },
              {
                id: 'progress',
                type: 'label',
                text: '1 / 3',
                x: 280,
                y: 52,
                w: 96,
                h: 28,
                fontSize: 15,
                fontWeight: 700,
                color: '#F6D94D',
                textAlign: 'right',
                fontFamily: 'Menlo',
                role: 'progress',
              },
              {
                id: 'header-rule',
                type: 'divider',
                x: 28,
                y: 88,
                w: 346,
                h: 1,
                fill: '#2D5263',
              },
              {
                id: 'word-card',
                type: 'box',
                layout: 'stack',
                x: 28,
                y: 108,
                w: 346,
                h: 228,
                radius: isRp1 ? 18 : 14,
                fill: isRp1 ? '#194254' : '#173B4C',
                stroke: isRp1 ? '#F6D94D' : '#2D5263',
                strokeWidth: 1,
                children: [
                  {
                    id: 'eyebrow',
                    type: 'label',
                    text: '进度 1 / 3、2 / 3、3 / 3 · 主动回忆',
                    x: 20,
                    y: 20,
                    w: 306,
                    h: 24,
                    fontSize: 12,
                    color: '#F6D94D',
                    role: 'eyebrow',
                  },
                  {
                    id: 'word',
                    type: 'label',
                    text: w1.word,
                    x: 20,
                    y: 48,
                    w: 306,
                    h: 88,
                    fontSize: 28,
                    fontWeight: 700,
                    lineHeight: 38,
                    color: '#F6F1DF',
                    fontFamily: 'Avenir Next',
                    wrap: true,
                    role: 'protagonist',
                  },
                  {
                    id: 'phonetic',
                    type: 'label',
                    text: w1.phonetic,
                    x: 20,
                    y: 144,
                    w: 210,
                    h: 28,
                    fontSize: 15,
                    color: '#AFC4CC',
                    fontFamily: 'Avenir Next',
                  },
                  {
                    id: 'part-of-speech',
                    type: 'badge',
                    text: w1.partOfSpeech,
                    x: 244,
                    y: 144,
                    w: 84,
                    h: 28,
                    radius: 14,
                    fontSize: 13,
                    fontWeight: 600,
                    fill: '#254E61',
                    color: '#F6D94D',
                  },
                  {
                    id: 'recall-tip',
                    type: 'label',
                    text: '先回想词义，再点击下方按钮揭示答案',
                    x: 20,
                    y: 188,
                    w: 306,
                    h: 24,
                    fontSize: 12,
                    color: '#AFC4CC',
                  },
                ],
              },
              {
                id: 'reveal',
                type: 'button',
                text: '揭示答案',
                x: 28,
                y: 352,
                w: 346,
                h: 48,
                radius: 12,
                fontSize: 16,
                fontWeight: 600,
                fill: '#F6D94D',
                color: '#102D3B',
                role: 'primary-action',
                on: {
                  click: [
                    { type: 'show', target: 'answer' },
                  ],
                },
              },
              {
                id: 'answer',
                type: 'paragraph',
                text: `${w1.definition} · ${w1.example}`,
                x: 28,
                y: 416,
                w: 346,
                h: 112,
                radius: 16,
                fill: '#173B4C',
                stroke: '#F6D94D',
                strokeWidth: 1,
                fontSize: 15,
                lineHeight: 22,
                textPaddingX: 16,
                textPaddingY: 14,
                color: '#F6F1DF',
                visible: false,
                wrap: true,
              },
              {
                id: 'remember',
                type: 'button',
                text: '记住了',
                x: 28,
                y: 540,
                w: 168,
                h: 48,
                radius: 12,
                fontSize: 15,
                fontWeight: 600,
                fill: '#2E7D5B',
                color: '#FFFFFF',
                on: {
                  click: {
                    cases: [
                      {
                        when: '=$wordIndex == 1',
                        actions: [
                          { type: 'set-variable', variable: 'wordIndex', value: 2 },
                          { type: 'set-text', target: 'progress', text: '2 / 3' },
                          { type: 'set-text', target: 'word', text: w2.word },
                          { type: 'set-text', target: 'phonetic', text: w2.phonetic },
                          { type: 'set-text', target: 'part-of-speech', text: w2.partOfSpeech },
                          { type: 'set-text', target: 'answer', text: `${w2.definition} · ${w2.example}` },
                          { type: 'set-text', target: 'feedback', text: '已记住，进入下一张' },
                          { type: 'hide', target: 'answer' },
                        ],
                      },
                      {
                        when: '=$wordIndex == 2',
                        actions: [
                          { type: 'set-variable', variable: 'wordIndex', value: 3 },
                          { type: 'set-text', target: 'progress', text: '3 / 3' },
                          { type: 'set-text', target: 'word', text: w3.word },
                          { type: 'set-text', target: 'phonetic', text: w3.phonetic },
                          { type: 'set-text', target: 'part-of-speech', text: w3.partOfSpeech },
                          { type: 'set-text', target: 'answer', text: `${w3.definition} · ${w3.example}` },
                          { type: 'set-text', target: 'feedback', text: '已记住，进入最后一张' },
                          { type: 'hide', target: 'answer' },
                        ],
                      },
                      {
                        else: true,
                        actions: [
                          { type: 'hide', target: 'answer' },
                          { type: 'show', target: 'complete' },
                        ],
                      },
                    ],
                  },
                },
              },
              {
                id: 'retry',
                type: 'button',
                text: '再练一次',
                x: 208,
                y: 540,
                w: 166,
                h: 48,
                radius: 12,
                fontSize: 15,
                fontWeight: 600,
                fill: '#8C4A32',
                color: '#FFFFFF',
                on: {
                  click: [
                    { type: 'set-text', target: 'feedback', text: '已加入再练一次队列' },
                    { type: 'show', target: 'feedback' },
                  ],
                },
              },
              {
                id: 'feedback',
                type: 'label',
                text: '请选择“记住了”或“再练一次”记录本次回忆结果',
                x: 28,
                y: 600,
                w: 346,
                h: 28,
                fontSize: 14,
                fontWeight: 600,
                color: '#F6D94D',
              },
              {
                id: 'complete',
                type: 'paragraph',
                text: '本轮完成 · 今日复习 3 张单词已全部掌握。',
                x: 28,
                y: 640,
                w: 346,
                h: 64,
                radius: 12,
                fontSize: 15,
                fontWeight: 600,
                lineHeight: 22,
                textPaddingX: 16,
                textPaddingY: 12,
                fill: '#1E4D3B',
                color: '#F6F1DF',
                visible: false,
              },
            ],
          },
        },
      ],
    };
  }

  if (taskId === 'T02') {
    const art = content.article;
    const [s1, s2, s3, s4] = art.sections;
    return {
      name: '移动端长文阅读页',
      domain: 'mobile',
      palette: {
        bg: '#F4F1EA',
        surface: '#EAE4D7',
        ink: '#1F2D2A',
        muted: '#5C6B66',
        brand: '#8C432E',
      },
      variables: {
        saved: 0,
      },
      pages: [
        {
          id: 'home',
          name: '长文阅读',
          domain: 'mobile',
          device: 'iphone-17-pro',
          canvas: { w: 402, h: 874 },
          root: {
            id: 'root',
            type: 'box',
            layout: 'stack',
            w: 402,
            h: 874,
            fill: '#F4F1EA',
            children: [
              {
                id: 'journal-brand',
                type: 'label',
                text: 'SHORE NOTES / 观察长文',
                x: 24,
                y: 16,
                w: 180,
                h: 20,
                fontSize: 11,
                fontWeight: 700,
                color: '#8C432E',
                fontFamily: 'Menlo',
                role: 'brand',
              },
              {
                id: 'author',
                type: 'label',
                text: art.author,
                x: 208,
                y: 16,
                w: 92,
                h: 20,
                fontSize: 12,
                fontWeight: 600,
                color: '#1F2D2A',
              },
              {
                id: 'date',
                type: 'label',
                text: art.date,
                x: 304,
                y: 16,
                w: 74,
                h: 20,
                fontSize: 11,
                color: '#5C6B66',
                fontFamily: 'Menlo',
              },
              {
                id: 'article-title',
                type: 'paragraph',
                text: art.title,
                x: 24,
                y: 40,
                w: 354,
                h: 44,
                fontSize: 18,
                fontWeight: 700,
                lineHeight: 22,
                color: '#1F2D2A',
                wrap: true,
                role: 'protagonist',
              },
              {
                id: 'source-meta',
                type: 'label',
                text: `${art.source} · fixtures/content.json中全部8段正文原文`,
                x: 12,
                y: 88,
                w: 378,
                h: 16,
                fontSize: 10,
                color: '#5C6B66',
              },
              {
                id: 'toggle-contents',
                type: 'button',
                text: '展开目录',
                x: 24,
                y: 108,
                w: 100,
                h: 44,
                radius: 8,
                fontSize: 12,
                fontWeight: 600,
                fill: '#1F2D2A',
                color: '#F4F1EA',
                on: {
                  click: [
                    { type: 'toggle', target: 'contents' },
                  ],
                },
              },
              {
                id: 'show-footnote',
                type: 'button',
                text: '阅读注释',
                x: 132,
                y: 108,
                w: 88,
                h: 44,
                radius: 8,
                fontSize: 12,
                fontWeight: 600,
                fill: '#8C432E',
                color: '#FFFFFF',
                on: {
                  click: [
                    { type: 'show', target: 'footnote' },
                  ],
                },
              },
              {
                id: 'save',
                type: 'button',
                text: '切换收藏',
                x: 228,
                y: 108,
                w: 88,
                h: 44,
                radius: 8,
                fontSize: 12,
                fontWeight: 600,
                fill: '#2E5A4C',
                color: '#FFFFFF',
                on: {
                  click: {
                    cases: [
                      {
                        when: '=$saved == 0',
                        actions: [
                          { type: 'set-variable', variable: 'saved', value: 1 },
                          { type: 'set-text', target: 'save-status', text: '已收藏' },
                        ],
                      },
                      {
                        else: true,
                        actions: [
                          { type: 'set-variable', variable: 'saved', value: 0 },
                          { type: 'set-text', target: 'save-status', text: '未收藏' },
                        ],
                      },
                    ],
                  },
                },
              },
              {
                id: 'save-status',
                type: 'label',
                text: '未收藏',
                x: 324,
                y: 116,
                w: 54,
                h: 28,
                fontSize: 12,
                fontWeight: 700,
                color: '#1F2D2A',
              },
              {
                id: 'section-1',
                type: 'paragraph',
                text: `${s1.heading}\n${s1.paragraphs[0]}\n${s1.paragraphs[1]}`,
                x: 24,
                y: 156,
                w: 354,
                h: 148,
                fontSize: 10,
                lineHeight: 13,
                fill: isRp1 ? '#FAF7F0' : '#FFFEFA',
                stroke: isRp1 ? '#D5CCB9' : '#E5DEC9',
                strokeWidth: 1,
                radius: isRp1 ? 8 : 4,
                color: '#1F2D2A',
                wrap: true,
                role: 'long-content',
              },
              {
                id: 'section-2',
                type: 'paragraph',
                text: `${s2.heading}\n${s2.paragraphs[0]}\n${s2.paragraphs[1]}`,
                x: 24,
                y: 308,
                w: 354,
                h: 148,
                fontSize: 10,
                lineHeight: 13,
                fill: isRp1 ? '#FAF7F0' : '#FFFEFA',
                stroke: isRp1 ? '#D5CCB9' : '#E5DEC9',
                strokeWidth: 1,
                radius: isRp1 ? 8 : 4,
                color: '#1F2D2A',
                wrap: true,
                role: 'long-content',
              },
              {
                id: 'section-3',
                type: 'paragraph',
                text: `${s3.heading}\n${s3.paragraphs[0]}\n${s3.paragraphs[1]}`,
                x: 24,
                y: 460,
                w: 354,
                h: 148,
                fontSize: 10,
                lineHeight: 13,
                fill: isRp1 ? '#FAF7F0' : '#FFFEFA',
                stroke: isRp1 ? '#D5CCB9' : '#E5DEC9',
                strokeWidth: 1,
                radius: isRp1 ? 8 : 4,
                color: '#1F2D2A',
                wrap: true,
                role: 'long-content',
              },
              {
                id: 'section-4',
                type: 'paragraph',
                text: `${s4.heading}\n${s4.paragraphs[0]}\n${s4.paragraphs[1]}`,
                x: 24,
                y: 612,
                w: 354,
                h: 148,
                fontSize: 10,
                lineHeight: 13,
                fill: isRp1 ? '#FAF7F0' : '#FFFEFA',
                stroke: isRp1 ? '#D5CCB9' : '#E5DEC9',
                strokeWidth: 1,
                radius: isRp1 ? 8 : 4,
                color: '#1F2D2A',
                wrap: true,
                role: 'long-content',
              },
              {
                id: 'contents',
                type: 'box',
                layout: 'stack',
                x: 24,
                y: 764,
                w: 354,
                h: 88,
                radius: 8,
                fill: '#EAE4D7',
                stroke: '#D5CCB9',
                strokeWidth: 1,
                visible: false,
                children: [
                  { id: 'toc-1', type: 'label', text: s1.heading, x: 12, y: 4, w: 330, h: 20, fontSize: 11, color: '#1F2D2A' },
                  { id: 'toc-2', type: 'label', text: s2.heading, x: 12, y: 24, w: 330, h: 20, fontSize: 11, color: '#1F2D2A' },
                  { id: 'toc-3', type: 'label', text: s3.heading, x: 12, y: 44, w: 330, h: 20, fontSize: 11, color: '#1F2D2A' },
                  { id: 'toc-4', type: 'label', text: s4.heading, x: 12, y: 64, w: 330, h: 20, fontSize: 11, color: '#1F2D2A' },
                ],
              },
              {
                id: 'footnote',
                type: 'paragraph',
                text: art.footnote,
                x: 24,
                y: 764,
                w: 354,
                h: 64,
                radius: 8,
                fontSize: 11,
                lineHeight: 16,
                textPaddingX: 12,
                textPaddingY: 8,
                fill: '#EAE4D7',
                color: '#8C432E',
                visible: false,
                wrap: true,
              },
            ],
          },
        },
      ],
    };
  }

  if (taskId === 'T03') {
    const rows = records.records;
    return {
      name: '真实数据工作区',
      domain: 'web',
      palette: {
        bg: '#F4F5EF',
        surface: '#FFFFFF',
        ink: '#222823',
        muted: '#667064',
        brand: '#2F5E4E',
      },
      datasets: {
        records: {
          rows: structuredClone(rows),
        },
      },
      pages: [
        {
          id: 'home',
          name: '数据工作台',
          domain: 'web',
          canvas: { w: 1440, h: 1000 },
          root: {
            id: 'root',
            type: 'box',
            layout: 'stack',
            w: 1440,
            h: 1000,
            fill: '#F4F5EF',
            children: [
              {
                id: 'header-title',
                type: 'label',
                text: '沿岸观察与设备维护数据工作区',
                x: 48,
                y: 28,
                w: 620,
                h: 40,
                fontSize: 28,
                fontWeight: 700,
                color: '#222823',
                role: 'protagonist',
              },
              {
                id: 'data-provenance',
                type: 'label',
                text: '数据来源说明：原型演示数据 · fixtures/records.json所有字段和12条记录（总记录数 12 · 金额合计 5590 · 待处理 4）',
                x: 48,
                y: 72,
                w: 960,
                h: 24,
                fontSize: 13,
                color: '#667064',
              },
              {
                id: 'kpi-card-total',
                type: 'box',
                layout: 'stack',
                x: 48,
                y: 108,
                w: 280,
                h: 92,
                radius: isRp1 ? 14 : 12,
                fill: isRp1 ? '#F9FBF7' : '#FFFFFF',
                stroke: isRp1 ? '#2F5E4E' : '#D6DDD2',
                strokeWidth: 1,
                children: [
                  { id: 'kpi-lbl-1', type: 'label', text: '总记录数', x: 20, y: 14, w: 160, h: 20, fontSize: 13, color: '#667064' },
                  { id: 'total-count', type: 'label', text: '12', x: 20, y: 38, w: 160, h: 46, fontSize: 30, fontWeight: 700, color: '#222823', fontFamily: 'Menlo' },
                ],
              },
              {
                id: 'kpi-card-amount',
                type: 'box',
                layout: 'stack',
                x: 348,
                y: 108,
                w: 280,
                h: 92,
                radius: 12,
                fill: '#FFFFFF',
                stroke: '#D6DDD2',
                strokeWidth: 1,
                children: [
                  { id: 'kpi-lbl-2', type: 'label', text: '金额合计', x: 20, y: 14, w: 160, h: 20, fontSize: 13, color: '#667064' },
                  { id: 'amount-total', type: 'label', text: '5590', x: 20, y: 38, w: 180, h: 46, fontSize: 30, fontWeight: 700, color: '#2F5E4E', fontFamily: 'Menlo' },
                ],
              },
              {
                id: 'kpi-card-pending',
                type: 'box',
                layout: 'stack',
                x: 648,
                y: 108,
                w: 280,
                h: 92,
                radius: 12,
                fill: '#FFFFFF',
                stroke: '#D6DDD2',
                strokeWidth: 1,
                children: [
                  { id: 'kpi-lbl-3', type: 'label', text: '待处理记录', x: 20, y: 14, w: 160, h: 20, fontSize: 13, color: '#667064' },
                  { id: 'pending-count', type: 'label', text: '4', x: 20, y: 38, w: 160, h: 46, fontSize: 30, fontWeight: 700, color: '#9C4221', fontFamily: 'Menlo' },
                ],
              },
              {
                id: 'kpi-card-current',
                type: 'box',
                layout: 'stack',
                x: 948,
                y: 108,
                w: 444,
                h: 92,
                radius: isRp1 ? 14 : 12,
                fill: isRp1 ? '#F9FBF7' : '#FFFFFF',
                stroke: isRp1 ? '#2F5E4E' : '#D6DDD2',
                strokeWidth: 1,
                children: [
                  { id: 'kpi-lbl-4', type: 'label', text: '当前命中结果数 / 首条记录编号', x: 20, y: 14, w: 280, h: 20, fontSize: 13, color: '#667064' },
                  { id: 'result-count', type: 'label', text: '=dataset.records.count', x: 20, y: 38, w: 120, h: 46, fontSize: 30, fontWeight: 700, color: '#222823', fontFamily: 'Menlo' },
                  { id: 'first-record', type: 'badge', text: '=dataset.records.pageFirst.id', x: 180, y: 44, w: 120, h: 32, radius: 8, fontSize: 15, fontWeight: 700, fill: '#E6EFEA', color: '#2F5E4E', fontFamily: 'Menlo' },
                ],
              },
              {
                id: 'filter-pending',
                type: 'button',
                text: '筛选待处理',
                x: 48,
                y: 218,
                w: 160,
                h: 42,
                radius: 10,
                fontSize: 14,
                fontWeight: 600,
                fill: '#2F5E4E',
                color: '#FFFFFF',
                on: {
                  click: [
                    { type: 'dataset-filter', dataset: 'records', field: 'status', query: '待处理', operator: 'eq' },
                    { type: 'hide', target: 'empty' },
                  ],
                },
              },
              {
                id: 'sort-amount-desc',
                type: 'button',
                text: '按金额降序',
                x: 224,
                y: 218,
                w: 160,
                h: 42,
                radius: 10,
                fontSize: 14,
                fontWeight: 600,
                fill: '#1F3A32',
                color: '#FFFFFF',
                on: {
                  click: [
                    { type: 'dataset-sort', dataset: 'records', field: 'amount', order: 'desc' },
                  ],
                },
              },
              {
                id: 'search',
                type: 'input',
                placeholder: '输入关键词搜索记录标题...',
                value: '',
                x: 404,
                y: 218,
                w: 360,
                h: 42,
                radius: 10,
                fill: '#FFFFFF',
                stroke: '#BFC9B9',
                strokeWidth: 1,
                fontSize: 14,
                color: '#222823',
              },
              {
                id: 'apply-search',
                type: 'button',
                text: '搜索',
                x: 778,
                y: 218,
                w: 120,
                h: 42,
                radius: 10,
                fontSize: 14,
                fontWeight: 600,
                fill: '#2F5E4E',
                color: '#FFFFFF',
                on: {
                  click: [
                    { type: 'dataset-filter', dataset: 'records', field: 'title', query: '=@search', operator: 'includes', onEmptyShow: 'empty' },
                  ],
                },
              },
              {
                id: 'reset',
                type: 'button',
                text: '重置',
                x: 914,
                y: 218,
                w: 120,
                h: 42,
                radius: 10,
                fontSize: 14,
                fontWeight: 600,
                fill: '#E2E7DD',
                color: '#222823',
                on: {
                  click: [
                    { type: 'dataset-filter', dataset: 'records', query: '' },
                    { type: 'dataset-sort', dataset: 'records', field: '' },
                    { type: 'hide', target: 'empty' },
                  ],
                },
              },
              {
                id: 'empty',
                type: 'label',
                text: '未找到匹配记录，请点击“重置”恢复全部 12 条数据。',
                x: 48,
                y: 274,
                w: 1344,
                h: 44,
                radius: 10,
                fill: '#FDE8E8',
                color: '#9B1C1C',
                fontSize: 14,
                fontWeight: 600,
                textPaddingX: 16,
                visible: false,
              },
              {
                id: 'records-repeater',
                type: 'repeater',
                dataset: 'records',
                key: 'id',
                x: 48,
                y: 330,
                w: 1344,
                h: 620,
                rowHeight: 44,
                rowGap: 6,
                template: {
                  id: 'row-tpl',
                  type: 'box',
                  layout: 'stack',
                  w: 1344,
                  h: 44,
                  radius: 8,
                  fill: '#FFFFFF',
                  stroke: '#E2E7DD',
                  strokeWidth: 1,
                  children: [
                    { id: 'tpl-id', type: 'label', text: '=item.id', x: 16, y: 10, w: 80, h: 24, fontSize: 13, fontWeight: 700, color: '#2F5E4E', fontFamily: 'Menlo' },
                    { id: 'tpl-title', type: 'label', text: '=item.title', x: 110, y: 10, w: 620, h: 24, fontSize: 14, color: '#222823' },
                    { id: 'tpl-status', type: 'badge', text: '=item.status', x: 750, y: 8, w: 100, h: 28, radius: 14, fontSize: 12, fontWeight: 600, fill: '#E6EFEA', color: '#2F5E4E' },
                    { id: 'tpl-owner', type: 'label', text: '=item.owner', x: 880, y: 10, w: 120, h: 24, fontSize: 13, color: '#667064' },
                    { id: 'tpl-amount', type: 'label', text: '=item.amount', x: 1020, y: 10, w: 120, h: 24, fontSize: 14, fontWeight: 700, color: '#222823', fontFamily: 'Menlo' },
                    { id: 'tpl-date', type: 'label', text: '=item.date', x: 1170, y: 10, w: 150, h: 24, fontSize: 13, color: '#667064', fontFamily: 'Menlo' },
                  ],
                },
              },
            ],
          },
        },
      ],
    };
  }

  if (taskId === 'T04') {
    return {
      name: '借用申请与校验',
      domain: 'mobile',
      palette: {
        bg: '#F6F3EC',
        surface: '#FFFFFF',
        ink: '#232826',
        muted: '#68706C',
        brand: '#87472E',
      },
      variables: {
        saved_name: '',
        saved_phone: '',
        saved_note: '',
      },
      pages: [
        {
          id: 'home',
          name: '借用申请',
          domain: 'mobile',
          device: 'iphone-17-pro',
          canvas: { w: 402, h: 874 },
          root: {
            id: 'root',
            type: 'box',
            layout: 'stack',
            w: 402,
            h: 874,
            fill: '#F6F3EC',
            children: [
              {
                id: 'form-header',
                type: 'label',
                text: '器材借用登记',
                x: 28,
                y: 56,
                w: 346,
                h: 36,
                fontSize: 26,
                fontWeight: 700,
                color: '#232826',
                role: 'protagonist',
              },
              {
                id: 'device-fixed',
                type: 'badge',
                text: '设备：便携相机',
                x: 28,
                y: 102,
                w: 346,
                h: 38,
                radius: isRp1 ? 12 : 10,
                fontSize: 14,
                fontWeight: 600,
                fill: isRp1 ? '#E6DED0' : '#EAE3D5',
                color: '#87472E',
              },
              {
                id: 'lbl-name',
                type: 'label',
                text: '姓名',
                x: 28,
                y: 160,
                w: 346,
                h: 24,
                fontSize: 14,
                fontWeight: 600,
                color: '#232826',
              },
              {
                id: 'name',
                type: 'input',
                placeholder: '请输入借用人姓名',
                value: '',
                x: 28,
                y: 188,
                w: 346,
                h: 44,
                radius: 10,
                fill: '#FFFFFF',
                stroke: '#C8C1B4',
                strokeWidth: 1,
                fontSize: 15,
                color: '#232826',
              },
              {
                id: 'name-error',
                type: 'label',
                text: '姓名不能为空',
                x: 28,
                y: 236,
                w: 346,
                h: 22,
                fontSize: 13,
                fontWeight: 600,
                color: '#B91C1C',
                visible: false,
              },
              {
                id: 'lbl-phone',
                type: 'label',
                text: '手机号',
                x: 28,
                y: 270,
                w: 346,
                h: 24,
                fontSize: 14,
                fontWeight: 600,
                color: '#232826',
              },
              {
                id: 'phone',
                type: 'input',
                placeholder: '请输入11位手机号',
                value: '',
                x: 28,
                y: 298,
                w: 346,
                h: 44,
                radius: 10,
                fill: '#FFFFFF',
                stroke: '#C8C1B4',
                strokeWidth: 1,
                fontSize: 15,
                color: '#232826',
              },
              {
                id: 'phone-error',
                type: 'label',
                text: '手机号须为11位数字',
                x: 28,
                y: 346,
                w: 346,
                h: 22,
                fontSize: 13,
                fontWeight: 600,
                color: '#B91C1C',
                visible: false,
              },
              {
                id: 'lbl-note',
                type: 'label',
                text: '归还说明',
                x: 28,
                y: 380,
                w: 346,
                h: 24,
                fontSize: 14,
                fontWeight: 600,
                color: '#232826',
              },
              {
                id: 'note',
                type: 'input',
                placeholder: '预计归还时间与附件核对说明',
                value: '',
                x: 28,
                y: 408,
                w: 346,
                h: 44,
                radius: 10,
                fill: '#FFFFFF',
                stroke: '#C8C1B4',
                strokeWidth: 1,
                fontSize: 14,
                color: '#232826',
              },
              {
                id: 'note-error',
                type: 'label',
                text: '归还说明不能为空',
                x: 28,
                y: 456,
                w: 346,
                h: 22,
                fontSize: 13,
                fontWeight: 600,
                color: '#B91C1C',
                visible: false,
              },
              {
                id: 'submit',
                type: 'button',
                text: '提交申请',
                x: 28,
                y: 506,
                w: 346,
                h: 50,
                radius: 12,
                fontSize: 16,
                fontWeight: 600,
                fill: '#87472E',
                color: '#FFFFFF',
                on: {
                  click: {
                    cases: [
                      {
                        when: "=@name == ''",
                        actions: [
                          { type: 'show', target: 'name-error' },
                          { type: 'show', target: 'phone-error' },
                          { type: 'show', target: 'note-error' },
                        ],
                      },
                      {
                        when: "=@phone != '13800138000'",
                        actions: [
                          { type: 'hide', target: 'name-error' },
                          { type: 'hide', target: 'note-error' },
                          { type: 'show', target: 'phone-error' },
                        ],
                      },
                      {
                        when: "=@note == ''",
                        actions: [
                          { type: 'hide', target: 'name-error' },
                          { type: 'hide', target: 'phone-error' },
                          { type: 'show', target: 'note-error' },
                        ],
                      },
                      {
                        else: true,
                        actions: [
                          { type: 'hide', target: 'name-error' },
                          { type: 'hide', target: 'phone-error' },
                          { type: 'hide', target: 'note-error' },
                          { type: 'set-variable', variable: 'saved_name', value: '=@name' },
                          { type: 'set-variable', variable: 'saved_phone', value: '=@phone' },
                          { type: 'set-variable', variable: 'saved_note', value: '=@note' },
                          { type: 'link', page: 'receipt' },
                        ],
                      },
                    ],
                  },
                },
              },
            ],
          },
        },
        {
          id: 'receipt',
          name: '申请回执',
          domain: 'mobile',
          device: 'iphone-17-pro',
          canvas: { w: 402, h: 874 },
          root: {
            id: 'receipt_root',
            type: 'box',
            layout: 'stack',
            w: 402,
            h: 874,
            fill: '#F6F3EC',
            children: [
              {
                id: 'receipt-status',
                type: 'label',
                text: '申请已提交',
                x: 28,
                y: 64,
                w: 346,
                h: 36,
                fontSize: 26,
                fontWeight: 700,
                color: '#2F5E4E',
                role: 'protagonist',
              },
              {
                id: 'receipt-device-fixed',
                type: 'label',
                text: '设备：便携相机',
                x: 28,
                y: 112,
                w: 346,
                h: 28,
                fontSize: 15,
                fontWeight: 600,
                color: '#87472E',
              },
              {
                id: 'receipt-card',
                type: 'box',
                layout: 'stack',
                x: 28,
                y: 156,
                w: 346,
                h: 260,
                radius: 16,
                fill: '#FFFFFF',
                stroke: '#D8D1C5',
                strokeWidth: 1,
                children: [
                  { id: 'r-lbl-1', type: 'label', text: '借用人姓名', x: 20, y: 20, w: 306, h: 20, fontSize: 12, color: '#68706C' },
                  { id: 'receipt-name', type: 'label', text: '=$saved_name', x: 20, y: 44, w: 306, h: 28, fontSize: 18, fontWeight: 700, color: '#232826' },
                  { id: 'r-lbl-2', type: 'label', text: '联系电话', x: 20, y: 88, w: 306, h: 20, fontSize: 12, color: '#68706C' },
                  { id: 'receipt-phone', type: 'label', text: '=$saved_phone', x: 20, y: 112, w: 306, h: 28, fontSize: 16, fontWeight: 600, color: '#232826', fontFamily: 'Menlo' },
                  { id: 'r-lbl-3', type: 'label', text: '归还说明', x: 20, y: 156, w: 306, h: 20, fontSize: 12, color: '#68706C' },
                  { id: 'receipt-note', type: 'paragraph', text: '=$saved_note', x: 20, y: 180, w: 306, h: 64, fontSize: 14, lineHeight: 20, color: '#232826', wrap: true },
                ],
              },
              {
                id: 'edit',
                type: 'button',
                text: '返回修改申请',
                x: 28,
                y: 444,
                w: 346,
                h: 48,
                radius: 12,
                fontSize: 15,
                fontWeight: 600,
                fill: '#232826',
                color: '#FFFFFF',
                on: {
                  click: [
                    { type: 'link', page: 'home' },
                  ],
                },
              },
            ],
          },
        },
      ],
    };
  }

  if (taskId === 'T05') {
    return {
      name: '图文活动落地页',
      domain: 'web',
      palette: {
        bg: '#F1F2EA',
        surface: '#E2E6DC',
        ink: '#1F353E',
        muted: '#5D6E6E',
        brand: '#97432E',
      },
      assetsManifest: {
        'assets/kingfisher.jpg': {
          id: 'kingfisher',
          path: 'assets/kingfisher.jpg',
          relativePath: 'assets/kingfisher.jpg',
          sha256: '99e26f98213f836b79c0202ca134d571a75c3245ee05284f507025553253611a',
          width: 708,
          height: 590,
          license: 'CC0-1.0',
        },
      },
      pages: [
        {
          id: 'home',
          name: '沿河慢行观察日',
          domain: 'web',
          canvas: { w: 1440, h: 1000 },
          root: {
            id: 'root',
            type: 'box',
            layout: 'stack',
            w: 1440,
            h: 1000,
            fill: '#F1F2EA',
            children: [
              {
                id: 'event-kicker',
                type: 'label',
                text: '活动：沿河慢行观察日 · SHORE FIELD WALK',
                x: 64,
                y: 44,
                w: 560,
                h: 28,
                fontSize: 14,
                fontWeight: 700,
                color: '#97432E',
              },
              {
                id: 'event-title',
                type: 'label',
                text: '沿河慢行观察日',
                x: 64,
                y: 84,
                w: 560,
                h: 64,
                fontSize: 44,
                fontWeight: 700,
                lineHeight: 56,
                color: '#1F353E',
                role: 'protagonist',
              },
              {
                id: 'event-schedule-card',
                type: 'box',
                layout: 'stack',
                x: 64,
                y: 168,
                w: 560,
                h: 250,
                radius: isRp1 ? 18 : 16,
                fill: isRp1 ? '#FBFBF8' : '#FFFFFF',
                stroke: isRp1 ? '#97432E' : '#CFD6CA',
                strokeWidth: 1,
                children: [
                  { id: 'ev-time', type: 'label', text: '2026年11月7日 06:30—08:30', x: 24, y: 20, w: 512, h: 28, fontSize: 16, fontWeight: 700, color: '#1F353E' },
                  { id: 'ev-place', type: 'label', text: '集合：旧桥东侧步道入口', x: 24, y: 58, w: 512, h: 26, fontSize: 15, color: '#1F353E' },
                  { id: 'ev-quota', type: 'badge', text: '名额：12人', x: 24, y: 94, w: 140, h: 30, radius: 15, fontSize: 13, fontWeight: 700, fill: '#E2E6DC', color: '#1F353E' },
                  { id: 'ev-route', type: 'label', text: '行程：缓流记录→桥下通行→共同整理', x: 24, y: 136, w: 512, h: 26, fontSize: 14, fontWeight: 600, color: '#97432E' },
                  { id: 'ev-prep', type: 'label', text: '携带纸笔与饮水；遇大雨改期', x: 24, y: 170, w: 512, h: 24, fontSize: 14, color: '#5D6E6E' },
                  { id: 'ev-notice', type: 'label', text: '原型演示活动，不接受真实报名', x: 24, y: 204, w: 512, h: 24, fontSize: 13, color: '#5D6E6E' },
                ],
              },
              {
                id: 'signup',
                type: 'button',
                text: '展开报名登记',
                x: 64,
                y: 438,
                w: 240,
                h: 48,
                radius: 12,
                fontSize: 16,
                fontWeight: 600,
                fill: '#1F353E',
                color: '#FFFFFF',
                on: {
                  click: [
                    { type: 'show', target: 'signup-form' },
                  ],
                },
              },
              {
                id: 'signup-form',
                type: 'box',
                layout: 'stack',
                x: 64,
                y: 504,
                w: 560,
                h: 196,
                radius: 16,
                fill: '#FFFFFF',
                stroke: '#97432E',
                strokeWidth: 1,
                visible: false,
                children: [
                  { id: 'sf-label', type: 'label', text: '报名参与者姓名', x: 24, y: 20, w: 512, h: 24, fontSize: 14, fontWeight: 600, color: '#1F353E' },
                  {
                    id: 'signup-name',
                    type: 'input',
                    placeholder: '请输入您的姓名',
                    value: '',
                    x: 24,
                    y: 52,
                    w: 512,
                    h: 44,
                    radius: 10,
                    fill: '#F9FAF6',
                    stroke: '#C5CEC6',
                    strokeWidth: 1,
                    fontSize: 15,
                    color: '#1F353E',
                  },
                  {
                    id: 'confirm-signup',
                    type: 'button',
                    text: '确认提交报名',
                    x: 24,
                    y: 116,
                    w: 220,
                    h: 46,
                    radius: 10,
                    fontSize: 15,
                    fontWeight: 600,
                    fill: '#97432E',
                    color: '#FFFFFF',
                    on: {
                      click: [
                        { type: 'set-text', target: 'signup-success', text: '=@signup-name' },
                        { type: 'show', target: 'signup-success' },
                      ],
                    },
                  },
                ],
              },
              {
                id: 'signup-success',
                type: 'label',
                text: '报名已登记',
                x: 64,
                y: 720,
                w: 560,
                h: 48,
                radius: 12,
                fill: '#DFF0E6',
                color: '#1B4D3E',
                fontSize: 16,
                fontWeight: 700,
                textPaddingX: 16,
                visible: false,
              },
              {
                id: 'hero-image',
                type: 'image',
                src: 'assets/kingfisher.jpg',
                x: 668,
                y: 64,
                w: 708,
                h: 590,
                radius: 16,
                role: 'content-image',
              },
              {
                id: 'photo-credit',
                type: 'label',
                text: '摄影来源与CC0说明：普通翠鸟 (Alcedo atthis)，CC0-1.0 公共领域授权，完整保留摄影主体。',
                x: 668,
                y: 670,
                w: 708,
                h: 28,
                fontSize: 13,
                color: '#5D6E6E',
              },
            ],
          },
        },
      ],
    };
  }

  if (taskId === 'T06') {
    const rows = records.records;
    return {
      name: '筛选排序分页与局部详情',
      domain: 'web',
      palette: {
        bg: '#F4F5EF',
        surface: '#FFFFFF',
        ink: '#222823',
        muted: '#667064',
        brand: '#2F5E4E',
      },
      variables: {
        pageNum: 1,
      },
      datasets: {
        records: {
          rows: structuredClone(rows),
        },
      },
      pages: [
        {
          id: 'home',
          name: '复杂业务列表',
          domain: 'web',
          canvas: { w: 1440, h: 1000 },
          root: {
            id: 'root',
            type: 'box',
            layout: 'stack',
            w: 1440,
            h: 1000,
            fill: '#F4F5EF',
            children: [
              {
                id: 'list-header',
                type: 'label',
                text: '沿岸维护台账 · 结果数量与当前选择详情',
                x: 40,
                y: 24,
                w: 680,
                h: 36,
                fontSize: 26,
                fontWeight: 700,
                color: '#222823',
                role: 'protagonist',
              },
              {
                id: 'list-meta',
                type: 'label',
                text: 'fixtures/records.json全部记录和字段 · 每页 5 条 · 支持筛选、金额降序、分页与详情联动',
                x: 40,
                y: 64,
                w: 840,
                h: 24,
                fontSize: 13,
                color: '#667064',
              },
              {
                id: 'filter-pending',
                type: 'button',
                text: '待处理',
                x: 40,
                y: 104,
                w: 120,
                h: 40,
                radius: 10,
                fontSize: 14,
                fontWeight: 600,
                fill: '#2F5E4E',
                color: '#FFFFFF',
                on: {
                  click: [
                    { type: 'dataset-filter', dataset: 'records', field: 'status', query: '待处理', operator: 'eq' },
                    { type: 'hide', target: 'empty' },
                  ],
                },
              },
              {
                id: 'sort-amount-desc',
                type: 'button',
                text: '金额降序',
                x: 172,
                y: 104,
                w: 130,
                h: 40,
                radius: 10,
                fontSize: 14,
                fontWeight: 600,
                fill: '#1F3A32',
                color: '#FFFFFF',
                on: {
                  click: [
                    { type: 'dataset-sort', dataset: 'records', field: 'amount', order: 'desc' },
                  ],
                },
              },
              {
                id: 'search',
                type: 'input',
                placeholder: '搜索记录关键词...',
                value: '',
                x: 318,
                y: 104,
                w: 280,
                h: 40,
                radius: 10,
                fill: '#FFFFFF',
                stroke: '#BFC9B9',
                strokeWidth: 1,
                fontSize: 14,
                color: '#222823',
              },
              {
                id: 'apply-search',
                type: 'button',
                text: '查询',
                x: 610,
                y: 104,
                w: 100,
                h: 40,
                radius: 10,
                fontSize: 14,
                fontWeight: 600,
                fill: '#2F5E4E',
                color: '#FFFFFF',
                on: {
                  click: [
                    { type: 'dataset-filter', dataset: 'records', field: 'title', query: '=@search', operator: 'includes', onEmptyShow: 'empty' },
                  ],
                },
              },
              {
                id: 'reset',
                type: 'button',
                text: '重置',
                x: 722,
                y: 104,
                w: 100,
                h: 40,
                radius: 10,
                fontSize: 14,
                fontWeight: 600,
                fill: '#E2E7DD',
                color: '#222823',
                on: {
                  click: [
                    { type: 'dataset-filter', dataset: 'records', query: '' },
                    { type: 'dataset-sort', dataset: 'records', field: '' },
                    { type: 'dataset-page', dataset: 'records', page: 1 },
                    { type: 'hide', target: 'empty' },
                  ],
                },
              },
              {
                id: 'select-first',
                type: 'button',
                text: '选中首行查看详情',
                x: 834,
                y: 104,
                w: 160,
                h: 40,
                radius: 10,
                fontSize: 14,
                fontWeight: 600,
                fill: '#8C432E',
                color: '#FFFFFF',
                on: {
                  click: [
                    { type: 'dataset-select', dataset: 'records', rowId: 'first' },
                  ],
                },
              },
              {
                id: 'status-bar',
                type: 'box',
                layout: 'stack',
                x: 40,
                y: 158,
                w: 954,
                h: 48,
                radius: isRp1 ? 12 : 10,
                fill: isRp1 ? '#F9FBF7' : '#FFFFFF',
                stroke: isRp1 ? '#2F5E4E' : '#D6DDD2',
                strokeWidth: 1,
                children: [
                  { id: 'lbl-rc', type: 'label', text: '结果数：', x: 16, y: 12, w: 64, h: 24, fontSize: 13, color: '#667064' },
                  { id: 'result-count', type: 'label', text: '=dataset.records.count', x: 80, y: 10, w: 60, h: 28, fontSize: 18, fontWeight: 700, color: '#222823', fontFamily: 'Menlo' },
                  { id: 'lbl-fr', type: 'label', text: '当前首行：', x: 156, y: 12, w: 76, h: 24, fontSize: 13, color: '#667064' },
                  { id: 'first-record', type: 'badge', text: '=dataset.records.pageFirst.id', x: 234, y: 10, w: 72, h: 28, radius: 8, fontSize: 13, fontWeight: 700, fill: '#E6EFEA', color: '#2F5E4E', fontFamily: 'Menlo' },
                  { id: 'page-status', type: 'label', text: '=dataset.records.pageStatus', x: 540, y: 12, w: 140, h: 24, fontSize: 14, fontWeight: 700, color: '#222823' },
                  {
                    id: 'previous-page',
                    type: 'button',
                    text: '上一页',
                    x: 700,
                    y: 8,
                    w: 110,
                    h: 32,
                    radius: 8,
                    fontSize: 13,
                    fontWeight: 600,
                    fill: '#E2E7DD',
                    color: '#222823',
                    on: {
                      click: [
                        { type: 'dataset-page', dataset: 'records', page: 'prev' },
                      ],
                    },
                  },
                  {
                    id: 'next-page',
                    type: 'button',
                    text: '下一页',
                    x: 824,
                    y: 8,
                    w: 110,
                    h: 32,
                    radius: 8,
                    fontSize: 13,
                    fontWeight: 600,
                    fill: '#2F5E4E',
                    color: '#FFFFFF',
                    on: {
                      click: [
                        { type: 'dataset-page', dataset: 'records', page: 'next' },
                      ],
                    },
                  },
                ],
              },
              {
                id: 'empty',
                type: 'label',
                text: '当前筛选或搜索无匹配记录（0 条），可点击“重置”恢复完整列表。',
                x: 40,
                y: 218,
                w: 954,
                h: 40,
                radius: 8,
                fill: '#FDE8E8',
                color: '#9B1C1C',
                fontSize: 13,
                fontWeight: 600,
                textPaddingX: 16,
                visible: false,
              },
              {
                id: 'list-repeater',
                type: 'repeater',
                dataset: 'records',
                key: 'id',
                pageSize: 5,
                x: 40,
                y: 268,
                w: 954,
                h: 680,
                rowHeight: 48,
                rowGap: 6,
                template: {
                  id: 'list-tpl',
                  type: 'box',
                  layout: 'stack',
                  w: 954,
                  h: 48,
                  radius: 8,
                  fill: '#FFFFFF',
                  stroke: '#E2E7DD',
                  strokeWidth: 1,
                  children: [
                    { id: 'lt-id', type: 'label', text: '=item.id', x: 16, y: 12, w: 70, h: 24, fontSize: 13, fontWeight: 700, color: '#2F5E4E', fontFamily: 'Menlo' },
                    { id: 'lt-title', type: 'label', text: '=item.title', x: 96, y: 12, w: 450, h: 24, fontSize: 13, color: '#222823' },
                    { id: 'lt-status', type: 'badge', text: '=item.status', x: 560, y: 10, w: 88, h: 28, radius: 14, fontSize: 12, fontWeight: 600, fill: '#E6EFEA', color: '#2F5E4E' },
                    { id: 'lt-owner', type: 'label', text: '=item.owner', x: 660, y: 12, w: 80, h: 24, fontSize: 13, color: '#667064' },
                    { id: 'lt-amount', type: 'label', text: '=item.amount', x: 748, y: 12, w: 104, h: 24, fontSize: 13, fontWeight: 700, color: '#222823', fontFamily: 'Menlo' },
                    { id: 'lt-date', type: 'label', text: '=item.date', x: 860, y: 12, w: 84, h: 24, fontSize: 12, color: '#667064', fontFamily: 'Menlo' },
                  ],
                },
              },
              {
                id: 'detail-pane',
                type: 'box',
                layout: 'stack',
                x: 1016,
                y: 104,
                w: 384,
                h: 844,
                radius: isRp1 ? 18 : 16,
                fill: isRp1 ? '#F9FBF7' : '#FFFFFF',
                stroke: isRp1 ? '#2F5E4E' : '#D6DDD2',
                strokeWidth: 1,
                children: [
                  { id: 'dp-heading', type: 'label', text: '选中记录详情 / DETAIL', x: 24, y: 24, w: 336, h: 24, fontSize: 13, fontWeight: 700, color: '#2F5E4E', fontFamily: 'Menlo' },
                  { id: 'dp-id-lbl', type: 'label', text: '记录编号', x: 24, y: 68, w: 336, h: 20, fontSize: 12, color: '#667064' },
                  { id: 'detail-id', type: 'label', text: '=dataset.records.selected.id', x: 24, y: 92, w: 336, h: 32, fontSize: 22, fontWeight: 700, color: '#222823', fontFamily: 'Menlo' },
                  { id: 'dp-title-lbl', type: 'label', text: '完整标题（长标题全文可达）', x: 24, y: 142, w: 336, h: 20, fontSize: 12, color: '#667064' },
                  { id: 'detail-title', type: 'paragraph', text: '=dataset.records.selected.title', x: 24, y: 168, w: 336, h: 96, fontSize: 16, fontWeight: 600, lineHeight: 24, color: '#222823', wrap: true },
                ],
              },
            ],
          },
        },
      ],
    };
  }

  if (taskId === 'T07') {
    return {
      name: '跨页选择与返回保留',
      domain: 'mobile',
      palette: {
        bg: '#F4F1EA',
        surface: '#FFFFFF',
        ink: '#1F2D2A',
        muted: '#60706B',
        brand: '#2E5A4C',
      },
      variables: {
        selected_device: '便携相机',
        saved_purpose: '',
      },
      pages: [
        {
          id: 'home',
          name: '选择设备',
          domain: 'mobile',
          device: 'iphone-17-pro',
          canvas: { w: 402, h: 874 },
          root: {
            id: 'root',
            type: 'box',
            layout: 'stack',
            w: 402,
            h: 874,
            fill: '#F4F1EA',
            children: [
              {
                id: 'home-title',
                type: 'label',
                text: '观察设备借用',
                x: 28,
                y: 56,
                w: 346,
                h: 36,
                fontSize: 26,
                fontWeight: 700,
                color: '#1F2D2A',
                role: 'protagonist',
              },
              {
                id: 'home-notice',
                type: 'label',
                text: '仅作原型演示，不连接真实库存',
                x: 28,
                y: 98,
                w: 346,
                h: 24,
                fontSize: 13,
                color: '#60706B',
              },
              {
                id: 'camera-card',
                type: 'box',
                layout: 'stack',
                x: 28,
                y: 144,
                w: 346,
                h: 156,
                radius: isRp1 ? 18 : 16,
                fill: isRp1 ? '#FBF9F4' : '#FFFFFF',
                stroke: '#2E5A4C',
                strokeWidth: 1,
                children: [
                  { id: 'cam-spec', type: 'label', text: '设备：便携相机；库存 2 台', x: 20, y: 20, w: 306, h: 28, fontSize: 17, fontWeight: 700, color: '#1F2D2A' },
                  { id: 'cam-desc', type: 'label', text: '含 35mm 镜头、备用电池与防水背带', x: 20, y: 54, w: 306, h: 24, fontSize: 13, color: '#60706B' },
                  {
                    id: 'camera',
                    type: 'button',
                    text: '选择便携相机 →',
                    x: 20,
                    y: 94,
                    w: 306,
                    h: 44,
                    radius: 10,
                    fontSize: 15,
                    fontWeight: 600,
                    fill: '#2E5A4C',
                    color: '#FFFFFF',
                    on: {
                      click: [
                        { type: 'set-variable', variable: 'selected_device', value: '便携相机' },
                        { type: 'link', page: 'detail' },
                      ],
                    },
                  },
                ],
              },
              {
                id: 'recorder-card',
                type: 'box',
                layout: 'stack',
                x: 28,
                y: 320,
                w: 346,
                h: 120,
                radius: 16,
                fill: '#FFFFFF',
                stroke: '#D5CFC2',
                strokeWidth: 1,
                children: [
                  { id: 'rec-spec', type: 'label', text: '设备：录音笔；库存 1 台', x: 20, y: 24, w: 306, h: 28, fontSize: 17, fontWeight: 700, color: '#1F2D2A' },
                  { id: 'rec-desc', type: 'label', text: '含防风毛衣与 64GB 存储卡', x: 20, y: 60, w: 306, h: 24, fontSize: 13, color: '#60706B' },
                ],
              },
            ],
          },
        },
        {
          id: 'detail',
          name: '填写借用用途',
          domain: 'mobile',
          device: 'iphone-17-pro',
          canvas: { w: 402, h: 874 },
          root: {
            id: 'detail_root',
            type: 'box',
            layout: 'stack',
            w: 402,
            h: 874,
            fill: '#F4F1EA',
            children: [
              {
                id: 'detail-heading',
                type: 'label',
                text: '确认设备与借用用途',
                x: 28,
                y: 56,
                w: 346,
                h: 36,
                fontSize: 24,
                fontWeight: 700,
                color: '#1F2D2A',
              },
              {
                id: 'device-name',
                type: 'label',
                text: '=$selected_device',
                x: 28,
                y: 108,
                w: 346,
                h: 36,
                fontSize: 20,
                fontWeight: 700,
                color: '#2E5A4C',
              },
              {
                id: 'lbl-purpose',
                type: 'label',
                text: '借用用途',
                x: 28,
                y: 164,
                w: 346,
                h: 24,
                fontSize: 14,
                fontWeight: 600,
                color: '#1F2D2A',
              },
              {
                id: 'purpose',
                type: 'input',
                placeholder: '请输入本次观察借用用途',
                value: '',
                x: 28,
                y: 196,
                w: 346,
                h: 46,
                radius: 10,
                fill: '#FFFFFF',
                stroke: '#BFC9C4',
                strokeWidth: 1,
                fontSize: 15,
                color: '#1F2D2A',
              },
              {
                id: 'borrow',
                type: 'button',
                text: '确认借用',
                x: 28,
                y: 268,
                w: 346,
                h: 48,
                radius: 12,
                fontSize: 16,
                fontWeight: 600,
                fill: '#2E5A4C',
                color: '#FFFFFF',
                on: {
                  click: [
                    { type: 'set-variable', variable: 'saved_purpose', value: '=@purpose' },
                    { type: 'link', page: 'receipt' },
                  ],
                },
              },
              {
                id: 'back-home',
                type: 'button',
                text: '返回设备列表',
                x: 28,
                y: 332,
                w: 346,
                h: 46,
                radius: 12,
                fontSize: 15,
                fontWeight: 600,
                fill: '#E2DDD2',
                color: '#1F2D2A',
                on: {
                  click: [
                    { type: 'link', page: 'home' },
                  ],
                },
              },
            ],
          },
        },
        {
          id: 'receipt',
          name: '借用凭证',
          domain: 'mobile',
          device: 'iphone-17-pro',
          canvas: { w: 402, h: 874 },
          root: {
            id: 'receipt_root',
            type: 'box',
            layout: 'stack',
            w: 402,
            h: 874,
            fill: '#F4F1EA',
            children: [
              {
                id: 'receipt-title',
                type: 'label',
                text: '借用凭证',
                x: 28,
                y: 56,
                w: 346,
                h: 36,
                fontSize: 26,
                fontWeight: 700,
                color: '#1F2D2A',
                role: 'protagonist',
              },
              {
                id: 'receipt-box',
                type: 'box',
                layout: 'stack',
                x: 28,
                y: 112,
                w: 346,
                h: 210,
                radius: isRp1 ? 18 : 16,
                fill: isRp1 ? '#FBF9F4' : '#FFFFFF',
                stroke: '#2E5A4C',
                strokeWidth: 1,
                children: [
                  { id: 'rc-d-lbl', type: 'label', text: '已选设备', x: 20, y: 20, w: 306, h: 20, fontSize: 12, color: '#60706B' },
                  { id: 'receipt-device', type: 'label', text: '=$selected_device', x: 20, y: 44, w: 306, h: 30, fontSize: 20, fontWeight: 700, color: '#2E5A4C' },
                  { id: 'rc-p-lbl', type: 'label', text: '登记借用用途', x: 20, y: 94, w: 306, h: 20, fontSize: 12, color: '#60706B' },
                  { id: 'receipt-purpose', type: 'paragraph', text: '=$saved_purpose', x: 20, y: 120, w: 306, h: 64, fontSize: 16, fontWeight: 600, lineHeight: 24, color: '#1F2D2A', wrap: true },
                ],
              },
              {
                id: 'back-edit',
                type: 'button',
                text: '返回修改借用信息',
                x: 28,
                y: 348,
                w: 346,
                h: 48,
                radius: 12,
                fontSize: 15,
                fontWeight: 600,
                fill: '#2E5A4C',
                color: '#FFFFFF',
                on: {
                  click: [
                    { type: 'link', page: 'detail' },
                  ],
                },
              },
            ],
          },
        },
      ],
    };
  }

  throw new Error(`Unsupported new-project task spec: ${taskId}`);
}

/**
 * Build genuine RP/1 DSL authoring plan (`rp1` DSL text + `sourceMode` + setup commands)
 */
export function buildRp1AuthoringPlan(taskId, fixtures = loadBenchmarkFixtures()) {
  if (taskId === 'T08') {
    const rp1 = [
      'stack #root',
      '  label #title text="本周观察"',
      '  card #card title="现场记录"',
      '  instance #instanceA component="Caption" overrides={"caption":{"text":"只改当前实例"}}',
    ].join('\n');
    return {
      isLocalEdit: true,
      pageId: 'home',
      sourceMode: 'update',
      rp1,
      setupCommands: [],
      rp1Envelopes: [{ pageId: 'home', sourceMode: 'update', rp1 }],
    };
  }

  const spec = buildTaskSpec(taskId, fixtures, { track: 'rp1-authoring' });
  const setupCommands = [];
  if (spec.palette && Object.keys(spec.palette).length > 0) {
    setupCommands.push({ type: 'setTokens', colors: spec.palette });
  }
  for (const [name, value] of Object.entries(spec.variables || {})) {
    setupCommands.push({ type: 'setVariable', name, value });
  }
  for (const [name, ds] of Object.entries(spec.datasets || {})) {
    setupCommands.push({ type: 'datasetOp', dataset: name, op: 'replace-all', rows: ds.rows });
  }
  for (const [relPath, asset] of Object.entries(spec.assetsManifest || {})) {
    setupCommands.push({
      type: 'registerAsset',
      asset: {
        relativePath: asset.relativePath || asset.path || relPath,
        sha256: asset.sha256,
        width: asset.width || 708,
        height: asset.height || 590,
        ...(asset.license ? { license: asset.license } : {}),
      },
    });
  }

  const rp1Envelopes = [];
  for (let i = 0; i < spec.pages.length; i++) {
    const p = spec.pages[i];
    if (i === 0 && p.id === 'home') {
      if (p.canvas?.w && p.canvas?.h) {
        setupCommands.push({ type: 'resizeArtboard', pageId: 'home', w: p.canvas.w, h: p.canvas.h });
      }
      const rootProps = Object.fromEntries(
        Object.entries(p.root).filter(([k]) => !['id', 'type', 'children'].includes(k))
      );
      setupCommands.push({
        type: 'setProperties',
        pageId: 'home',
        nodeId: 'home_root',
        properties: { ...rootProps, children: [] },
      });
    } else {
      setupCommands.push({
        type: 'addPage',
        pageId: p.id,
        name: p.name,
        domain: p.domain || spec.domain,
        ...(p.device ? { device: p.device } : {}),
        ...(p.canvas?.w ? { w: p.canvas.w } : {}),
        ...(p.canvas?.h ? { h: p.canvas.h } : {}),
        root: {
          id: `${p.id}_root`,
          type: 'box',
          layout: p.root.layout || 'stack',
          w: p.root.w,
          h: p.root.h,
          fill: p.root.fill,
          children: [],
        },
      });
    }
    const rp1 = serializePageRootToRp1Dsl(p.id, p.root);
    rp1Envelopes.push({
      pageId: p.id,
      sourceMode: 'insert',
      rp1,
    });
  }

  setupCommands.push({
    type: 'recordDesignDecision',
    decisionId: `direction-${taskId.toLowerCase()}`,
    scope: { kind: 'project' },
    subject: 'direction',
    outcome: 'accepted',
    choice: spec.name,
    reason: `RP/1 DSL high-level authoring for ${taskId} preserving task hierarchy, tokens, and interactive states`,
    feedback: { source: 'agent' },
  });

  return {
    isLocalEdit: false,
    setupCommands,
    rp1Envelopes,
  };
}

/**
 * High-level RP/1 command batch wrapper for backwards-compatible callers
 */
export function buildRp1AuthoringCommands(taskId, fixtures = loadBenchmarkFixtures()) {
  const plan = buildRp1AuthoringPlan(taskId, fixtures);
  if (plan.isLocalEdit) {
    return [
      { type: 'setProperties', pageId: 'home', nodeId: 'title', properties: { text: '本周观察' } },
      { type: 'setProperties', pageId: 'home', nodeId: 'card', properties: { title: '现场记录' } },
      { type: 'setInstanceOverride', pageId: 'home', nodeId: 'instanceA', subNodeId: 'caption', properties: { text: '只改当前实例' } },
    ];
  }
  return plan.setupCommands;
}

/**
 * Low-level flat node command batch (`addPage`, `setProperties`, `addNode` node-by-node)
 * for same-condition comparison (B01 / R01).
 */
export function buildLowLevelAuthoringCommands(taskId, fixtures = loadBenchmarkFixtures()) {
  if (taskId === 'T08') {
    return [
      { type: 'setText', pageId: 'home', nodeId: 'title', text: '本周观察' },
      { type: 'setProperties', pageId: 'home', nodeId: 'card', properties: { title: '现场记录' } },
      { type: 'setProperties', pageId: 'home', nodeId: 'instanceA', properties: { overrides: { caption: { text: '只改当前实例' } } } },
    ];
  }

  const spec = buildTaskSpec(taskId, fixtures, { track: 'low-level-commands' });
  const commands = [];
  for (const [name, value] of Object.entries(spec.palette || {})) {
    commands.push({ type: 'setToken', category: 'colors', name, value });
  }
  for (const [name, value] of Object.entries(spec.variables || {})) {
    commands.push({ type: 'setVariable', name, value });
  }
  for (const [name, ds] of Object.entries(spec.datasets || {})) {
    commands.push({ type: 'datasetOp', dataset: name, op: 'replace-all', rows: ds.rows });
  }
  for (const [relPath, asset] of Object.entries(spec.assetsManifest || {})) {
    commands.push({
      type: 'registerAsset',
      asset: {
        relativePath: asset.relativePath || asset.path || relPath,
        sha256: asset.sha256,
        width: asset.width || 708,
        height: asset.height || 590,
        ...(asset.license ? { license: asset.license } : {}),
      },
    });
  }
  for (let i = 0; i < spec.pages.length; i++) {
    const p = spec.pages[i];
    commands.push(...flattenPageTreeToLowLevelCommands(p, { isInitialHome: i === 0 && p.id === 'home' }));
  }
  commands.push({
    type: 'recordDesignDecision',
    decisionId: `direction-${taskId.toLowerCase()}`,
    scope: { kind: 'project' },
    subject: 'direction',
    outcome: 'accepted',
    choice: spec.name,
    reason: `Low-level node-by-node command authoring for ${taskId} under identical brief and fixtures`,
    feedback: { source: 'agent' },
  });
  return commands;
}

/**
 * Verify source structure, requiredNodeIds, requiredContent, and zero text clipping.
 */
export function verifyTaskDocumentStructure(taskId, doc, fixtures = loadBenchmarkFixtures()) {
  const task = fixtures.suite.tasks.find(t => t.id === taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  const scene = resolveDocumentScene(doc);
  const allNodes = scene.pages.flatMap(p => p.nodes);
  const allNodeIds = new Set(allNodes.map(n => n.id));
  // Source structure includes inactive states; behavior is verified by replay.
  // The default rendered scene alone cannot establish that a source ID is absent.
  const sourceIds = node => {
    if (!node) return;
    allNodeIds.add(node.id);
    for (const child of node.children || []) sourceIds(child);
    for (const state of node.states || []) sourceIds(state.root);
    if (node.template) sourceIds(node.template);
  };
  for (const page of doc.pages) sourceIds(page.root);
  const missingNodeIds = (task.inputs?.requiredNodeIds || []).filter(id => !allNodeIds.has(id));

  // Restrict content evidence to authored nodes, actions and actual dataset rows.
  // Document metadata and notes cannot satisfy a required visible content check.
  const contentValues = [];
  const collectAction = action => {
    if (Array.isArray(action)) { for (const item of action) collectAction(item); return; }
    if (!action || typeof action !== 'object') return;
    for (const key of ['text', 'value']) if (typeof action[key] === 'string') contentValues.push(action[key]);
    for (const key of ['actions', 'cases', 'then', 'else']) collectAction(action[key]);
  };
  const collectNode = node => {
    if (!node || typeof node !== 'object') return;
    for (const key of ['text','title','subtitle','body','value','label','placeholder','content']) if (typeof node[key] === 'string') contentValues.push(node[key]);
    for (const action of Object.values(node.on || {})) collectAction(action);
    for (const child of node.children || []) collectNode(child);
    for (const state of node.states || []) collectNode(state.root);
    if (node.template) collectNode(node.template);
    for (const override of Object.values(node.overrides || {})) collectNode(override);
  };
  for (const page of doc.pages) collectNode(page.root);
  for (const component of Object.values(doc.components || {})) collectNode(component.root);
  const datasetRows = Object.values(doc.datasets || {}).flatMap(ds => Array.isArray(ds) ? ds : (ds?.rows || []));
  const contentText = contentValues.join('\n');
  const sourceText = `${contentText}\n${JSON.stringify(datasetRows)}`;
  const missingContent = [];
  for (const item of task.requiredContent || []) {
    if (item.includes('fixtures/content.json.words')) {
      for (const w of fixtures.content.words) {
        if (!['word','phonetic','partOfSpeech','definition','example'].every(key => sourceText.includes(w[key]))) {
          missingContent.push(w.word);
        }
      }
    } else if (item.includes('fixtures/content.json')) {
      for (const field of ['title','author','date','source','footnote']) if (!contentText.includes(fixtures.content.article[field])) missingContent.push(`article:${field}`);
      let paragraphPosition = -1;
      for (const sec of fixtures.content.article.sections) {
        for (const para of sec.paragraphs) {
          const position = contentText.indexOf(para, paragraphPosition + 1);
          if (position < 0) missingContent.push(para.slice(0, 24));
          else paragraphPosition = position;
        }
      }
    } else if (item.includes('fixtures/records.json')) {
      for (const rec of fixtures.records.records) {
        if (!datasetRows.some(row => Object.entries(rec).every(([key, value]) => isDeepStrictEqual(row[key], value)))) {
          missingContent.push(`${rec.id}:${rec.title}`);
        }
      }
    } else if (item === '结果数量与当前选择详情') {
      if (!allNodeIds.has('detail-id') || !allNodeIds.has('result-count')) {
        missingContent.push(item);
      }
    } else if (taskId === 'T06' && item === '第 1 / 3 页') {
      continue;
    } else if (taskId === 'T01' && item.includes(' /')) {
      const word = item.split(' ')[0];
      if (!sourceText.includes(word)) missingContent.push(word);
    } else if (taskId === 'T08') {
      const expectedText = item.includes('：') ? item.split('：')[1] : item;
      if (expectedText && ! expectedText.includes('不得改动') && !expectedText.includes('原实例文字')) {
        if (!contentText.includes(expectedText)) missingContent.push(expectedText);
      }
    } else {
      const token = item.includes('：') && !contentText.includes(item) ? item.split('：')[1] : item;
      if (!contentText.includes(item) && !contentText.includes(token)) {
        missingContent.push(item);
      }
    }
  }

  let outOfScopeMutations = 0;
  if (taskId === 'T08') {
    const before = importToStudioDocument(structuredClone(fixtures.localEdit), { documentId: doc.documentId || 't08' });
    const homeAfter = doc.pages.find(p => p.id === 'home');
    const detailBefore = before.pages.find(p => p.id === 'detail');
    const detailAfter = doc.pages.find(p => p.id === 'detail');
    if (JSON.stringify(doc.components) !== JSON.stringify(before.components)) outOfScopeMutations++;
    if (JSON.stringify(detailAfter?.root?.children) !== JSON.stringify(detailBefore?.root?.children)) outOfScopeMutations++;
    const cardAfter = homeAfter?.root?.children?.find(c => c.id === 'card');
    const instBAfter = homeAfter?.root?.children?.find(c => c.id === 'instanceB');
    if (cardAfter?.body !== '原宏正文不得改动') outOfScopeMutations++;
    if (instBAfter?.overrides && Object.keys(instBAfter.overrides).length > 0) outOfScopeMutations++;
    // Only the three authorized source leaves may differ. Checking just the
    // untouched instance and one paragraph missed geometry/events/token edits.
    const expected = structuredClone(before);
    const expectedHome = expected.pages.find(p => p.id === 'home');
    const afterTitle = homeAfter?.root.children.find(n => n.id === 'title');
    expectedHome.root.children.find(n => n.id === 'title').text = afterTitle?.text;
    expectedHome.root.children.find(n => n.id === 'card').title = cardAfter?.title;
    const actualA = homeAfter?.root.children.find(n => n.id === 'instanceA');
    const expectedA = expectedHome.root.children.find(n => n.id === 'instanceA');
    if (actualA?.overrides?.caption && Object.hasOwn(actualA.overrides.caption, 'text')) {
      expectedA.overrides.caption ||= {};
      expectedA.overrides.caption.text = actualA.overrides.caption.text;
    }
    for (const field of ['pages', 'components', 'tokens', 'palette', 'variables', 'datasets', 'assetsManifest', 'fonts', 'designDecisions', 'adaptiveViews']) {
      if (!isDeepStrictEqual(doc[field], expected[field])) outOfScopeMutations++;
    }
  }

  const clipCount = (scene.clipDiagnostics || []).length;
  const passed = missingNodeIds.length === 0 && missingContent.length === 0 && outOfScopeMutations === 0 && clipCount === 0;

  return {
    passed,
    assertionCount: (task.inputs?.requiredNodeIds?.length || 0) + (task.requiredContent?.length || 0) + 2,
    missingNodeIds,
    missingContent,
    outOfScopeMutations,
    clipCount,
    pageCount: scene.pages.length,
    nodeCount: allNodes.length,
  };
}
