import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertNotProtected } from './engine.mjs';

export function resolveBlankTemplate() {
  // Axure macOS 安装包只有教学工程，没有独立空白 .rp；使用用户本机保存的空白工程，不随代码分发。
  const template = resolve(process.env.AXURE_BLANK_TEMPLATE || join(homedir(), 'Library/Application Support/zee-rp/templates/axure-rp11-blank.rp'));
  assertNotProtected(template);
  if (!existsSync(template)) throw new Error('缺少本机空白模板。请在 Axure RP 11 新建单页空白工程，保存为新文件，并设置 AXURE_BLANK_TEMPLATE 指向它。代码包不包含 Axure .rp 模板。');
  return template;
}
