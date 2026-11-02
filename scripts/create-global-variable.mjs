import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { readRecords, encodeRecord, replaceRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field } from './parse-payload.mjs';

function stringNode(strings, text) {
  let index = strings.indexOf(text);
  if (index < 0) {
    index = strings.length;
    strings.push(text);
  }
  return { tag: 8, value: index + 1, text };
}

export function removeGlobalVariable(file, name) {
  const record = readRecords(file).find(r => r.className === 'Axure:DesignDocument');
  const doc = parsePayload(record);
  const variable = [...doc.objects.values()].find(o => o.className === 'Axure:GlobalVariable'
    && field(o.body, 'name')?.text === name);
  if (!variable) return file;
  const varSet = [...doc.objects.values()].find(o => o.className === 'Axure:GlobalVariableSet');
  const list = field(varSet.body, 'global-variables');
  list.items = list.items.filter(item => item.value !== variable.id);
  doc.roots = doc.roots.filter(node => node !== variable);
  return replaceRecord(file, record, encodeRecord(record, record.strings, encodePayload(doc.roots)));
}

export function createGlobalVariable(file, name, { defaultValue = '' } = {}) {
  const buf = Buffer.isBuffer(file) ? file : Buffer.from(file);
  if (buf[0] !== 0xac || buf[1] !== 0xef) {
    throw new Error('Input must be an Axure .rp project buffer');
  }
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('Global variable name must not be empty');
  }
  const varName = name.trim();

  const records = readRecords(buf);
  const docIndex = records.findIndex(record => record.className === 'Axure:DesignDocument');
  if (docIndex < 0) throw new Error('Axure:DesignDocument record not found');
  const docRecord = records[docIndex];
  const doc = parsePayload(docRecord);
  const strings = [...docRecord.strings];

  const varSet = [...doc.objects.values()].find(o => o.className === 'Axure:GlobalVariableSet');
  if (!varSet) throw new Error('Axure:GlobalVariableSet object not found in DesignDocument');

  const globalVarsList = field(varSet.body, 'global-variables');
  if (!globalVarsList || globalVarsList.tag !== 2) {
    throw new Error('global-variables list not found in GlobalVariableSet');
  }

  const existingVars = (globalVarsList.items ?? []).map(it => doc.objects.get(it.value));
  for (const ev of existingVars) {
    const existingName = field(ev?.body ?? {}, 'name')?.text;
    if (existingName && existingName.toLowerCase() === varName.toLowerCase()) {
      throw new Error(`Global variable "${varName}" already exists`);
    }
  }

  const roots1e = doc.roots.find(r => r.tag === 0x1e);
  if (!roots1e || !Array.isArray(roots1e.values)) {
    throw new Error('DesignDocument GUID root table (tag 0x1e) not found');
  }

  const varGuid = randomBytes(16).toString('hex');
  roots1e.values.push(varGuid);
  const varId = roots1e.values.length;

  let maxId = 0;
  for (const id of doc.objects.keys()) {
    if (id > maxId) maxId = id;
  }
  const newObjId = maxId + 1;

  let classIndex = strings.indexOf('Axure:GlobalVariable');
  if (classIndex < 0) {
    classIndex = strings.length;
    strings.push('Axure:GlobalVariable');
  }
  classIndex += 1;

  const newVarObj = {
    tag: 9,
    className: 'Axure:GlobalVariable',
    id: newObjId,
    classIndex,
    body: {
      tag: 1,
      entries: [
        [stringNode(strings, 'name'), stringNode(strings, varName)],
        [stringNode(strings, 'variable-id'), { tag: 0x11, value: varId }],
        [stringNode(strings, 'default-value'), stringNode(strings, String(defaultValue))]
      ]
    }
  };

  doc.objects.set(newObjId, newVarObj);
  globalVarsList.items.push({ tag: 3, value: newObjId });

  let lastVarRootIndex = -1;
  for (let i = 0; i < doc.roots.length; i++) {
    if (doc.roots[i].className === 'Axure:GlobalVariable') lastVarRootIndex = i;
  }
  if (lastVarRootIndex >= 0) {
    doc.roots.splice(lastVarRootIndex + 1, 0, newVarObj);
  } else {
    const varSetIndex = doc.roots.findIndex(r => r.className === 'Axure:GlobalVariableSet');
    doc.roots.splice(varSetIndex + 1, 0, newVarObj);
  }

  const newPayload = encodePayload(doc.roots);
  const rawRecord = encodeRecord(docRecord, strings, newPayload);
  const out = replaceRecord(buf, docRecord, rawRecord);
  return { file: out, variableId: varId, variableGuid: varGuid };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let defaultValue = '';
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--default-value' && i + 1 < args.length) {
      defaultValue = args[++i];
    } else {
      positional.push(args[i]);
    }
  }

  const [sourcePath, outputPath, varName] = positional;
  if (!sourcePath || !outputPath || !varName) {
    console.error('Usage: node scripts/create-global-variable.mjs <source.rp> <output.rp> <VariableName> [--default-value "Value"]');
    process.exit(1);
  }

  const source = readFileSync(sourcePath);
  const { file, variableId, variableGuid } = createGlobalVariable(source, varName, { defaultValue });
  writeFileSync(outputPath, Buffer.from(file), { flag: 'wx' });
  console.log(`Created global variable "${varName}" (id=${variableId}, guid=${variableGuid}) -> ${outputPath}`);
}
