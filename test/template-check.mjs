import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveBlankTemplate } from '../scripts/blank-template.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { cloneLibraryWidget } from '../scripts/clone-library-widget.mjs';
import { createGlobalVariable } from '../scripts/create-global-variable.mjs';
import { addInteractions } from '../scripts/ix-actions.mjs';
import { validateSemantics } from './check-semantics.mjs';
import { fixturePath } from './native-inputs.mjs';

const skill = dirname(dirname(fileURLToPath(import.meta.url)));

test('blank template & end-to-end native pipeline contracts', () => {
  const work = mkdtempSync(join(tmpdir(), 'axure-template-check-'));
  const template = resolveBlankTemplate();
  const run = (command, args, path) => spawnSync(process.execPath, [join(skill, 'bin/axure.mjs'), command, ...args], {
    encoding: 'utf8', env: { ...process.env, AXURE_WRITE_ROOT: work, AXURE_BLANK_TEMPLATE: path, AXURE_PROTECTED_PATH: process.env.AXURE_PROTECTED_PATH || '/zee-rp-test-protected/final.rp' }
  });
  try {
    // 1. 显式本机模板产物逐字节一致
    {
      const out = join(work, 'blank.rp'); assert.equal(run('create-blank-project', [out], template).status, 0);
      assert.ok(readFileSync(out).equals(readFileSync(template)));
    }
    // 2. 新建空白页保持原页并新增单个空页
    {
      const out = join(work, 'page.rp'); assert.equal(run('create-blank-page', [template, out, 'New blank'], template).status, 0);
      const rp = readRp(readFileSync(out)); assert.equal(rp.counts.pages, 2); assert.equal(rp.counts.widgets, 0);
      assert.equal(rp.counts.problems, 0); assert.ok(rp.pages.some(p => p.name === 'New blank'));
    }
    // 3. 缺失模板拒绝且没有输出
    {
      const out = join(work, 'missing.rp'); assert.notEqual(run('create-blank-project', [out], join(work, 'no-template.rp')).status, 0); assert.ok(!existsSync(out));
    }
    // 4. 非空模板拒绝且没有输出
    {
      const out = join(work, 'nonblank.rp');
      const nonBlank = existsSync(fixturePath('var-set-counter-roundtrip.rp')) ? fixturePath('var-set-counter-roundtrip.rp') : join(work, 'page.rp');
      assert.notEqual(run('create-blank-project', [out], nonBlank).status, 0); assert.ok(!existsSync(out));
    }
    // 5. 模板变量不能指向受保护成品
    {
      const out = join(work, 'protected.rp');
      const r = run('create-blank-project', [out], '/zee-rp-test-protected/final.rp');
      assert.notEqual(r.status, 0); assert.ok(r.stderr.includes('受保护')); assert.ok(!existsSync(out));
    }
    // 6. 端到端流水线: 创建工程 -> 加空页 -> 克隆组件 -> 改名 -> 加变量与条件交互 -> 语义闭环通过
    {
      const p1 = join(work, 'step1-project.rp');
      assert.equal(run('create-blank-project', [p1], template).status, 0);
      const p2 = join(work, 'step2-page2.rp');
      assert.equal(run('create-blank-page', [p1, p2, 'Page 2'], template).status, 0);
      const p3 = join(work, 'step3-cloned.rp');
      const libPath = '/Applications/Axure RP 11.app/Contents/Resources/DefaultSettings/Libraries/Default.rplib';
      const cloned = cloneLibraryWidget(libPath, p2, p3, {
        sourcePageName: 'Box 1',
        targetPageName: 'Page 2',
        name: 'WIDGET_BOX',
        x: 100, y: 100
      });
      const p4 = join(work, 'step4-renamed.rp');
      const nameWidgetScript = join(skill, 'scripts/name-widget.mjs');
      execFileSync(process.execPath, [nameWidgetScript, p3, p4, 'Page 2', String(cloned.id), 'HERO_BANNER']);
      const p5Result = createGlobalVariable(readFileSync(p4), 'ThemeMode', { defaultValue: 'dark' });
      const p6Result = addInteractions(p5Result.file, 'HERO_BANNER', [{
        event: 'OnClick',
        cases: [{
          description: 'Case Dark Mode',
          when: {
            op: '==',
            left: { variable: 'ThemeMode' },
            right: { value: 'dark' }
          },
          actions: [{ type: 'set-text', target: 'HERO_BANNER', text: 'Dark Theme Active' }]
        }],
        page: 'Page 2'
      }]);
      const finalRp = readRp(p6Result.file);
      assert.equal(finalRp.counts.pages, 2, 'Must have exactly 2 pages');
      assert.equal(finalRp.records.unparseable, 0);
      assert.equal(finalRp.counts.danglingRefs, 0);
      assert.equal(finalRp.counts.problems, 0);
      const sem = validateSemantics(p6Result.file);
      assert.equal(sem.valid, true, `Semantics failed: ${JSON.stringify(sem.violations)}`);
      assert.equal(sem.violationCount, 0);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
