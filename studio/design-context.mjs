import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const benchmarkRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'studio', 'qiyu-field-notes');
const principles = [
  '先写清每页的用户任务、必备内容、主要操作与状态，再决定构图。',
  '根据题材选择参考；可以从基础节点自由设计，不必调用三套固定模板。',
  '素材的主体、图框与文字留白共同决定画面；保留原图与配方。',
  '品牌约束和信息优先级必须参与设计，不支持的约束要明确说明。',
  '修改后查看对应版本的真实截图，记录具体问题、涉及节点与下一次改稿。',
  '交互、原生交付和视觉评价分开记录，不以自评分代替看图或用户验收。',
];

export function getDesignContext({ intent = 'editorial', pageId = 'home', includeImages = true } = {}) {
  if (!['editorial', 'task', 'learning'].includes(intent)) throw Object.assign(new Error('intent 请选择 editorial、task 或 learning'), { code: 'E_DESIGN_INTENT' });
  const suitable = intent === 'editorial';
  if (!['home', 'species', 'record', 'saved'].includes(pageId)) throw Object.assign(new Error(`标杆页面不存在：${pageId}`), { code: 'E_REFERENCE_PAGE' });
  const page = pageId;
  const metadata = JSON.parse(readFileSync(join(benchmarkRoot, 'benchmark.json'), 'utf8'));
  const hashes = JSON.parse(readFileSync(join(benchmarkRoot, 'manifest.json'), 'utf8'));
  for (const [path, expected] of Object.entries(hashes.files)) {
    if (!existsSync(join(benchmarkRoot, path)) || createHash('sha256').update(readFileSync(join(benchmarkRoot, path))).digest('hex') !== expected) {
      throw Object.assign(new Error(`标杆文件已变化，需重新审查：${path}`), { code: 'E_BENCHMARK_DRIFT' });
    }
  }
  return {
    ok: true, intent, principles,
    reference: suitable ? { ...metadata, root: benchmarkRoot, sourcePath: join(benchmarkRoot, 'source.json'),
      mediaRecipes: join(benchmarkRoot, 'media-recipes.json'), selectedPage: page,
      pageSource: JSON.parse(readFileSync(join(benchmarkRoot, 'source.json'))).pages.find(p => p.id === page) } : null,
    guidance: suitable ? '学习摄影叙事与状态组织，不直接复制色板、构图或固定坐标。'
      : intent === 'task' ? '当前没有已获用户认可的工具型标杆；优先检索、状态和操作效率，不套栖羽大幅封面。'
        : '当前没有已获用户认可的学习型标杆；优先阅读、翻面、反馈和进度，不套自然手记主题。',
    workflow: ['明确任务和内容', '选择参考及设计理由', '准备媒体', '原子命令自由构图', '查看版本截图', '记录问题并改稿', '验证业务与原生输出'],
    ...(suitable && includeImages ? { mcpImages: [{ mimeType: 'image/png', data: readFileSync(join(benchmarkRoot, 'previews', `${page}.png`)).toString('base64') }] } : {}),
  };
}
