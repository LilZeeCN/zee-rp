import { fixturePath } from './native-inputs.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';


import { readRecords } from '../scripts/rp-records.mjs';
import { field, parsePayload } from '../scripts/parse-payload.mjs';
import { addInteractions } from '../scripts/ix-actions.mjs';

export function runStyleParameterChecks() {
  const results = [];
  const check = (name, run) => {
    try { run(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, detail: error.message }); }
  };

  check('apply-style fontSize uses native property ID 2 and preserves full style', () => {
    const source = readFileSync(fixturePath('var-set-counter-roundtrip.rp'));
    const { file } = addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      cases: [{ actions: [{ type: 'apply-style', fill: '#FF3366', textColor: '#D72638', borderColor: '#0000FF', borderWidth: 9, opacity: 50, fontSize: 28, fontFamily: 'Courier New' }] }],
    }], { replaceEvent: true });
    const page = readRecords(file).find(record => record.className === 'Axure:Page');
    const graph = parsePayload(page);
    const action = [...graph.objects.values()].find(object => object.className === 'Axure:InteractionApplyStyle');
    assert.ok(action, 'ApplyStyle action missing');
    const info = graph.objects.get(field(action.body, 'Infos').items[0].value);
    const style = graph.objects.get(field(info.body, 'style').value);
    assert.equal(field(style.body, 'All').value, true);
    const properties = field(style.body, 'PropList').items;
    const property = id => properties.find(item => (field(item, 'DOAName').value & 0x3fffffff) === id);
    assert.equal(properties.length, 57);
    assert.equal(field(property(8), 'DOAName').value, 0xc0000008);
    assert.equal(field(field(property(8), 'Value'), 'fill-type').text, 'solid');
    assert.equal(field(field(property(8), 'Value'), 'fill-color').value, 0xff0000ff);
    assert.equal(field(property(6), 'DOAName').value, 0xc0000006);
    assert.equal(field(field(property(6), 'Value'), 'fill-type').text, 'solid');
    assert.equal(field(field(property(6), 'Value'), 'fill-color').value, 0xffd72638);
    assert.equal(field(field(property(7), 'Value'), 'fill-color').value, 0xffff3366);
    assert.equal(field(property(15), 'Value').value, 9);
    assert.equal(field(property(70), 'DOAName').value, 0xc0000046);
    assert.equal(field(property(70), 'Value').value, 0.5);
    assert.equal(field(property(2), 'DOAName').value, 0xc0000002);
    assert.equal(field(property(2), 'Value').value, 21);
    assert.equal(field(property(1), 'DOAName').value, 0xc0000001);
    assert.equal(field(property(1), 'Value').text, 'Courier New');
  });

  check('apply-style opacity rejects values outside 0..100', () => {
    const source = readFileSync(fixturePath('var-set-counter-roundtrip.rp'));
    for (const opacity of [-1, 100.1, Infinity, NaN]) {
      assert.throws(() => addInteractions(source, 'SET_BUTTON', [{
        event: 'OnClick',
        cases: [{ actions: [{ type: 'apply-style', opacity }] }],
      }]), /apply-style opacity must be a finite number from 0 to 100/);
    }
  });

  check('apply-style fontSize rejects non-positive and non-finite values', () => {
    const source = readFileSync(fixturePath('var-set-counter-roundtrip.rp'));
    for (const fontSize of [-1, 0, Infinity, NaN]) {
      assert.throws(() => addInteractions(source, 'SET_BUTTON', [{
        event: 'OnClick',
        cases: [{ actions: [{ type: 'apply-style', fontSize }] }],
      }]), /apply-style fontSize must be a finite positive number/);
    }
  });

  check('apply-style fontFamily rejects empty and non-string values', () => {
    const source = readFileSync(fixturePath('var-set-counter-roundtrip.rp'));
    for (const fontFamily of ['', '   ', 12, null]) {
      assert.throws(() => addInteractions(source, 'SET_BUTTON', [{
        event: 'OnClick',
        cases: [{ actions: [{ type: 'apply-style', fontFamily }] }],
      }]), /apply-style fontFamily must be a non-empty string/);
    }
  });

  check('apply-style bold writes native property ID 3', () => {
    const source = readFileSync(fixturePath('var-set-counter-roundtrip.rp'));
    const { file } = addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      cases: [{ actions: [{ type: 'apply-style', bold: true }] }],
    }], { replaceEvent: true });
    const page = readRecords(file).find(record => record.className === 'Axure:Page');
    const graph = parsePayload(page);
    const action = [...graph.objects.values()].find(object => object.className === 'Axure:InteractionApplyStyle');
    assert.ok(action, 'ApplyStyle action missing');
    const info = graph.objects.get(field(action.body, 'Infos').items[0].value);
    const style = graph.objects.get(field(info.body, 'style').value);
    const properties = field(style.body, 'PropList').items;
    const bold = properties.find(item => (field(item, 'DOAName').value & 0x3fffffff) === 3);
    assert.equal(field(bold, 'DOAName').value, 0xc0000003);
    assert.equal(field(bold, 'Value').value, 0);
  });

  check('apply-style bold=false writes the native unchecked property value', () => {
    const source = readFileSync(fixturePath('var-set-counter-roundtrip.rp'));
    const { file } = addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      cases: [{ actions: [{ type: 'apply-style', bold: false }] }],
    }], { replaceEvent: true });
    const page = readRecords(file).find(record => record.className === 'Axure:Page');
    const graph = parsePayload(page);
    const action = [...graph.objects.values()].find(object => object.className === 'Axure:InteractionApplyStyle');
    const info = graph.objects.get(field(action.body, 'Infos').items[0].value);
    const style = graph.objects.get(field(info.body, 'style').value);
    const bold = field(style.body, 'PropList').items.find(item => (field(item, 'DOAName').value & 0x3fffffff) === 3);
    assert.equal(field(bold, 'DOAName').value, 0xc0000003);
    assert.equal(field(bold, 'Value').value, 2);
    assert.equal(field(info.body, 'clear-previous').value, false);
  });

  check('apply-style bold rejects non-boolean values', () => {
    const source = readFileSync(fixturePath('var-set-counter-roundtrip.rp'));
    for (const bold of [null, 0, 1, 'false']) {
    assert.throws(() => addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
        cases: [{ actions: [{ type: 'apply-style', bold }] }],
      }]), /apply-style bold must be a boolean/);
    }
  });

  check('apply-style italic=true is rejected because preview leaves fontStyle normal', () => {
    const source = readFileSync(fixturePath('var-set-counter-roundtrip.rp'));
    assert.throws(() => addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      cases: [{ actions: [{ type: 'apply-style', italic: true }] }],
    }], { replaceEvent: true }), /apply-style italic=true is unavailable: the serialized action did not change computed fontStyle/);
  });

  check('apply-style italic=false is rejected because runtime support is unverified', () => {
    const source = readFileSync(fixturePath('var-set-counter-roundtrip.rp'));
    assert.throws(() => addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      cases: [{ actions: [{ type: 'apply-style', italic: false }] }],
    }], { replaceEvent: true }), /apply-style italic=false is unavailable: the serialized action did not change computed fontStyle/);
  });

  check('apply-style italic rejects non-boolean values', () => {
    const source = readFileSync(fixturePath('var-set-counter-roundtrip.rp'));
    for (const italic of [null, 0, 1, 'false']) {
      assert.throws(() => addInteractions(source, 'SET_BUTTON', [{
        event: 'OnClick',
        cases: [{ actions: [{ type: 'apply-style', italic }] }],
      }]), /apply-style italic must be a boolean/);
    }
  });

  check('apply-style underline writes native property ID 5', () => {
    const source = readFileSync(fixturePath('var-set-counter-roundtrip.rp'));
    const { file } = addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      cases: [{ actions: [{ type: 'apply-style', underline: true }] }],
    }], { replaceEvent: true });
    const page = readRecords(file).find(record => record.className === 'Axure:Page');
    const graph = parsePayload(page);
    const action = [...graph.objects.values()].find(object => object.className === 'Axure:InteractionApplyStyle');
    assert.ok(action, 'ApplyStyle action missing');
    const info = graph.objects.get(field(action.body, 'Infos').items[0].value);
    const style = graph.objects.get(field(info.body, 'style').value);
    const underline = field(style.body, 'PropList').items.find(item => (field(item, 'DOAName').value & 0x3fffffff) === 5);
    assert.equal(field(underline, 'DOAName').value, 0xc0000005);
    assert.equal(field(underline, 'Value').value, true);
  });

  check('apply-style underline rejects unverified false value', () => {
    const source = readFileSync(fixturePath('var-set-counter-roundtrip.rp'));
    assert.throws(() => addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      cases: [{ actions: [{ type: 'apply-style', underline: false }] }],
    }]), /apply-style underline currently supports true only/);
  });

  check('apply-style strikethrough writes Boolean property ID 95', () => {
    const source = readFileSync(fixturePath('var-set-counter-roundtrip.rp'));
    const { file } = addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      cases: [{ actions: [{ type: 'apply-style', strikethrough: true }] }],
    }], { replaceEvent: true });
    const page = readRecords(file).find(record => record.className === 'Axure:Page');
    const graph = parsePayload(page);
    const action = [...graph.objects.values()].find(object => object.className === 'Axure:InteractionApplyStyle');
    assert.ok(action, 'ApplyStyle action missing');
    const info = graph.objects.get(field(action.body, 'Infos').items[0].value);
    const style = graph.objects.get(field(info.body, 'style').value);
    const strikethrough = field(style.body, 'PropList').items.find(item => (field(item, 'DOAName').value & 0x3fffffff) === 95);
    assert.equal(field(strikethrough, 'DOAName').value, 0xc000005f);
    assert.equal(field(strikethrough, 'Value').value, true);
  });

  check('apply-style strikethrough rejects unverified false value', () => {
    const source = readFileSync(fixturePath('var-set-counter-roundtrip.rp'));
    assert.throws(() => addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      cases: [{ actions: [{ type: 'apply-style', strikethrough: false }] }],
    }]), /apply-style strikethrough currently supports true only/);
  });

  check('apply-style borderColor rejects non-hex colors', () => {
    const source = readFileSync(fixturePath('var-set-counter-roundtrip.rp'));
    assert.throws(() => addInteractions(source, 'SET_BUTTON', [{
      event: 'OnClick',
      cases: [{ actions: [{ type: 'apply-style', borderColor: 'blue' }] }],
    }]), /apply-style borderColor must be #RRGGBB/);
  });

  check('apply-style textColor rejects non-hex colors', () => {
    const source = readFileSync(fixturePath('var-set-counter-roundtrip.rp'));
    for (const textColor of ['red', '#FFF', '#12345678', '123456']) {
      assert.throws(() => addInteractions(source, 'SET_BUTTON', [{
        event: 'OnClick',
        cases: [{ actions: [{ type: 'apply-style', textColor }] }],
      }]), /apply-style textColor must be #RRGGBB/);
    }
  });

  return results;
}
