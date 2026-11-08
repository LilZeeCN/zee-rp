import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDesignGuidance } from './design-guidance.mjs';
import { getPhaseContext } from './phase-context.mjs';

export const benchmarkRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'studio', 'qiyu-field-notes');
const principles = [
  '先写清每页的用户任务、必备内容、主要操作与状态，再决定构图。',
  '根据题材选择参考；可以从基础节点自由设计，不必调用三套固定模板。',
  '素材的主体、图框与文字留白共同决定画面；保留原图与配方。',
  '品牌约束和信息优先级必须参与设计，不支持的约束要明确说明。',
  '修改后查看对应版本的真实截图，记录具体问题、涉及节点与下一次改稿。',
  '交互、原生交付和视觉评价分开记录，不以自评分代替看图或用户验收。',
];

export function verifyBenchmarkFiles(root = benchmarkRoot) {
  const hashes = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  for (const [path, expected] of Object.entries(hashes.files)) {
    if (!existsSync(join(root, path)) || createHash('sha256').update(readFileSync(join(root, path))).digest('hex') !== expected) {
      throw Object.assign(new Error(`标杆文件已变化，需重新审查：${path}`), { code: 'E_BENCHMARK_DRIFT' });
    }
  }
}

function getLegacyDesignContext({ intent = 'editorial', pageId = 'home', includeImages = true, platform = 'mobile', guideId = null } = {}) {
  if (!['editorial', 'task', 'learning'].includes(intent)) throw Object.assign(new Error('intent 请选择 editorial、task 或 learning'), { code: 'E_DESIGN_INTENT' });
  const designGuidance = getDesignGuidance({ intent, platform, guideId });
  const suitable = intent === 'editorial';
  if (suitable && !['home', 'species', 'record', 'saved'].includes(pageId)) throw Object.assign(new Error(`标杆页面不存在：${pageId}`), { code: 'E_REFERENCE_PAGE' });
  const page = pageId;
  const metadata = suitable ? JSON.parse(readFileSync(join(benchmarkRoot, 'benchmark.json'), 'utf8')) : null;
  if (suitable) verifyBenchmarkFiles();
  return {
    ok: true, intent, platform, principles, designGuidance,
    reference: suitable ? { ...metadata, root: benchmarkRoot, sourcePath: join(benchmarkRoot, 'source.json'),
      mediaRecipes: join(benchmarkRoot, 'media-recipes.json'), selectedPage: page,
      pageSource: JSON.parse(readFileSync(join(benchmarkRoot, 'source.json'))).pages.find(p => p.id === page) } : null,
    guidance: suitable ? '学习摄影叙事与状态组织，不直接复制色板、构图或固定坐标。'
      : intent === 'task' ? '当前没有已获用户认可的工具型标杆；designGuidance 提供原创任务配方，先保证信息、状态与操作，再选择视觉方向。'
        : '当前没有已获用户认可的学习型标杆；designGuidance 提供原创学习配方，优先回忆、阅读、反馈与进度，再探索不同视觉语言。',
    authoring: {
      events: { canonical: { on: { click: [{ type: 'show', target: 'answer' }] } }, aliases: ['onClick'], note: '隐藏容器默认隐藏后代；显示容器恢复各后代自己的显隐。' },
      scenario: { steps: [{ expect: { visible: { answer: false } } }, { action: 'click', target: 'reveal', expect: { visible: { answer: true } } }],
        actions: ['click', 'input', 'navigate', 'dataset', 'expect'], rule: '使用 action/expect；未知字段、空断言与没有断言的场景均拒绝。' },
      layout: { modes: ['stack', 'free', 'row', 'column', 'grid'], coordinates: 'x/y 是父内容盒坐标；row/column/grid 用顺序、gap、hug/fill 排版；任意构图可混合嵌套。空白手机的 home_screen 默认 padding=[60,0,0,0]，其子节点 y=0 已是屏幕 y=60；先查父 padding，勿再次加60。全屏装饰可将该容器 padding 设为0，再自行保留顶部60px安全区。注意产物路径差异：这条安全区规则只适用 generate_prototype/空白模板的 phone-shell+home_screen；studio_command 的 addPage 生成的是裸 box 根（layout=stack、padding=0、无 phone-shell 与顶部安全区），其子节点 y=0 会顶进状态栏/灵动岛，顶部安全距离需自行留出。',
        example: { type: 'addNode', parentId: '页面根节点 ID', node: { id: 'region', type: 'box', layout: 'column', w: 340, h: 'hug', gap: 16, children: [{ id: 'heading', type: 'label', text: '具体内容', w: 'fill', h: 'hug' }] } } },
      iteration: '先检查真实初始态与交互态，再比较候选；原生结构成功不等于浏览器业务通过。',
    },
    workflow: ['明确任务和内容', '选择参考及设计理由', '准备媒体', '原子命令自由构图', '查看版本截图', '记录问题并改稿', '验证业务与原生输出'],
    ...(suitable && includeImages ? { mcpImages: [{ mimeType: 'image/png', data: readFileSync(join(benchmarkRoot, 'previews', `${page}.png`)).toString('base64') }] } : {}),
  };
}

export function getDesignContext(args = {}, project = {}) {
  if (args.stage !== undefined || args.target !== undefined || args.referencePackId !== undefined) return getPhaseContext(args, project);
  return getLegacyDesignContext(args);
}
