import { fixturePath } from './native-inputs.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';


import { createGlobalVariable } from '../scripts/create-global-variable.mjs';
import { readRp } from '../scripts/rp-read.mjs';
import { addInteractions } from '../scripts/ix-actions.mjs';

export function runCreateGlobalVariableChecks() {
  const results = [];
  const check = (name, run) => {
    try { run(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, detail: error.message }); }
  };

  check('createGlobalVariable appends a new variable with defaultValue and three-zero health', () => {
    const source = readFileSync(fixturePath('var-set-counter-roundtrip.rp'));
    const beforeRp = readRp(source);
    const initialVarCount = beforeRp.globalVariables.length;

    const { file, variableId, variableGuid } = createGlobalVariable(source, 'NEW_TEST_VAR', { defaultValue: 'CUSTOM_INIT_VALUE' });
    assert.ok(file instanceof Uint8Array);
    assert.ok(Number.isInteger(variableId) && variableId > 0);
    assert.ok(typeof variableGuid === 'string' && variableGuid.length === 32);

    const afterRp = readRp(file);
    assert.equal(afterRp.problems.length, 0, 'new file should have 0 problems');
    assert.equal(afterRp.globalVariables.length, initialVarCount + 1);

    const added = afterRp.globalVariables.find(v => v.name === 'NEW_TEST_VAR');
    assert.ok(added, 'new variable must be present in readRp summary');
    assert.equal(added.value, 'CUSTOM_INIT_VALUE');
    assert.equal(added.variableId, variableId);

    // 既有变量不动
    assert.ok(afterRp.globalVariables.some(v => v.name === 'DemoValue'));
  });

  check('createGlobalVariable rejects duplicate variable names and empty names', () => {
    const source = readFileSync(fixturePath('var-set-counter-roundtrip.rp'));
    assert.throws(() => createGlobalVariable(source, 'DemoValue'), /already exists/);
    assert.throws(() => createGlobalVariable(source, 'demovalue'), /already exists/);
    assert.throws(() => createGlobalVariable(source, '   '), /name must not be empty/);
    assert.throws(() => createGlobalVariable(Buffer.from('not an rp'), 'X'), /must be an Axure \.rp/);
  });

  check('newly created global variable is directly consumable by ix-actions condition and assignment', () => {
    const source = readFileSync(fixturePath('var-set-counter-roundtrip.rp'));
    const { file } = createGlobalVariable(source, 'ACTIVE_FLAG', { defaultValue: 'false' });

    // 用 ix-actions 条件消费该变量，并设置它
    const { file: finalFile } = addInteractions(file, 'SET_BUTTON', [{
      event: 'OnClick',
      cases: [{
        when: { op: '==', left: { variable: 'ACTIVE_FLAG' }, right: { value: 'false' } },
        actions: [{ type: 'set-variable', variable: 'ACTIVE_FLAG', value: 'true' }]
      }]
    }], { replaceEvent: true });

    const finalRp = readRp(finalFile);
    assert.equal(finalRp.problems.length, 0);
  });

  return results;
}
