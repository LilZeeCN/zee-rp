import { readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readRecords, encodeRecord, replaceRecord, appendPackage } from './rp-records.mjs';
import { parsePayload, encodePayload, field, walkNodes } from './parse-payload.mjs';
import { guidKey } from './duplicate-page.mjs';

import { resolveBlankTemplate } from './blank-template.mjs';
import { detectFileVersion } from './version.mjs';

function stringNode(strings, text) {
  let index = strings.indexOf(text);
  if (index < 0) {
    index = strings.length;
    strings.push(text);
  }
  return { tag: 8, value: index + 1, text };
}

function packageName(info, strings) {
  const packageId = field(info.body, 'package-id');
  const type = strings[packageId?.values?.[0] - 1];
  return type === 'Axure:Page' ? field(info.body, 'package-name')?.text : undefined;
}

export function createBlankPage(file, newName) {
  if (!Buffer.isBuffer(file) || file[0] !== 0xac || file[1] !== 0xef) {
    throw new Error('Input must be an Axure .rp project buffer');
  }
  if (typeof newName !== 'string' || !newName.trim()) throw new Error('Page name must not be empty');

  const records = readRecords(file);
  const documentRecord = records.find(record => record.className === 'Axure:DesignDocument');
  if (!documentRecord) throw new Error('Axure DesignDocument record not found');
  const document = parsePayload(documentRecord);
  const documentData = document.roots[0]?.values;
  if (!Array.isArray(documentData)) throw new Error('Unsupported DesignDocument payload');
  const strings = [...documentRecord.strings];
  const infos = [...document.objects.values()].filter(object => object.className === 'Axure:PackageInfo');
  const existingNames = infos.map(info => packageName(info, strings)).filter(Boolean);
  if (!existingNames.length) throw new Error('No existing page package found');
  if (existingNames.some(name => name.toLocaleLowerCase() === newName.toLocaleLowerCase())) {
    throw new Error(`Page already exists: ${newName}`);
  }

  // 模板必须和输入文件同版本：把 RP 11 的空白 Page 加进 RP 9 工程会是跨版本混装。
  const template = readFileSync(resolveBlankTemplate(detectFileVersion(file)));
  const blankPage = readRecords(template).find(record => record.className === 'Axure:Page');
  if (!blankPage) throw new Error('Native blank Page record not found in template');
  const page = parsePayload(blankPage);
  const pageObject = [...page.objects.values()].find(object => object.className === 'Axure:Page');
  const diagram = page.objects.get(field(pageObject?.body ?? {}, 'diagram')?.value);
  const diagramObjects = field(diagram?.body ?? {}, 'diagram-objects')?.items ?? [];
  const hasWidgets = [...page.objects.values()].some(object =>
    object.className.startsWith('Axure:DiagramObject:') || object.className.startsWith('Axure:Repeater'));
  if (!pageObject || diagramObjects.length || hasWidgets) {
    throw new Error('Resolved template Page record is no longer blank');
  }

  const pageGuids = page.roots.find(root => root.tag === 0x1e)?.values;
  const packageIndex = page.roots.find(root => root.tag === 0x12)?.value;
  if (!Array.isArray(pageGuids) || !packageIndex || packageIndex > pageGuids.length) {
    throw new Error('Unsupported blank Page GUID table');
  }
  const sharedGuid = '00000000000000000000000000000000';
  const externalGuidRefs = [];
  page.roots.forEach(root => walkNodes([root], node => {
    if (node.tag === 0x16) externalGuidRefs.push(node.value);
  }));
  if (externalGuidRefs.some(index => pageGuids[index - 1] !== sharedGuid)) {
    throw new Error('Bundled blank Page contains an unsupported external GUID reference');
  }
  const newPackage = randomBytes(16).toString('hex');
  for (const id of page.objects.keys()) pageGuids[id - 1] = randomBytes(16).toString('hex');
  pageGuids[packageIndex - 1] = newPackage;

  const sourceInfo = infos.find(info => packageName(info, strings));
  const alloc = hex => {
    documentData.push(hex ?? randomBytes(16).toString('hex'));
    return documentData.length;
  };
  const newNodeId = alloc();
  const newInfoId = alloc();
  const newPackageId = alloc(newPackage);
  const newInfo = structuredClone(sourceInfo);
  newInfo.id = newInfoId;
  field(newInfo.body, 'package-id').values[1] = newPackageId;
  Object.assign(field(newInfo.body, 'package-name'), stringNode(strings, newName));

  const root = document.objects.get(document.roots.find(node => node.tag === 0x0f)?.value);
  const site = document.objects.get(field(root?.body ?? {}, 'sitemap')?.value);
  const tree = document.objects.get(field(site?.body ?? {}, 'tree')?.value);
  if (!root || !site || !tree) throw new Error('Sitemap structure not found');
  const ref = value => ({ tag: 3, value });
  field(root.body, 'PackageInfos').items.push(ref(newInfoId));
  field(site.body, 'node-table').entries.push([
    ref(newNodeId),
    { tag: 0x13, values: [stringNode(strings, 'Axure:PackageInfo').value, newPackageId] }
  ]);
  field(tree.body, 'children').items.push(ref(newNodeId));
  const node = {
    tag: 9,
    id: newNodeId,
    classIndex: stringNode(strings, 'Axure:Node').value,
    className: 'Axure:Node',
    body: {
      tag: 1,
      entries: [
        [stringNode(strings, 'children'), { tag: 2, items: [] }],
        [stringNode(strings, 'parent-node'), ref(tree.id)],
        [stringNode(strings, 'tree'), ref(tree.id)]
      ]
    }
  };
  document.roots.splice(document.roots.length - 1, 0, newInfo, node);

  let output = replaceRecord(file, documentRecord, encodeRecord(documentRecord, strings, encodePayload(document.roots)));
  output = appendPackage(output, guidKey(newPackage), encodeRecord(blankPage, blankPage.strings, encodePayload(page.roots)));
  return {
    file: output,
    report: { newName, template: 'Axure RP 11.0.0.4137 macOS native blank page', pages: existingNames.length + 1 }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [inputPath, outputPath, newName] = process.argv.slice(2);
  if (!inputPath || !outputPath || !newName) {
    console.error('Usage: node create-blank-page.mjs <input.rp> <output.rp> <newPageName>');
    process.exit(1);
  }
  if (extname(outputPath).toLowerCase() !== '.rp') throw new Error('Output path must end in .rp');
  const input = readFileSync(resolve(inputPath));
  const result = createBlankPage(input, newName);
  writeFileSync(resolve(outputPath), result.file, { flag: 'wx' });
  console.log(JSON.stringify({ output: resolve(outputPath), ...result.report }, null, 2));
}
