import { fixturePath } from './native-inputs.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_DIR } from './fixture-summary.mjs';
import { setWidgetRichText } from '../scripts/set-widget-richtext.mjs';
import { readRecords } from '../scripts/rp-records.mjs';
import { field, parsePayload } from '../scripts/parse-payload.mjs';
import { readRp } from '../scripts/rp-read.mjs';

export function runRichTextParameterChecks() {
  const results = [];
  const check = (name, run) => {
    try { run(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, detail: error.message }); }
  };

  check('RichText paragraph lineSpacing writes native Float64 and preserves defaults', () => {
    const source = readFileSync(fixturePath('richtext-v2-gui-edit.rp'));
    const { file } = setWidgetRichText(source, {
      page: 'Page 1', widget: 'RICH_TEXT',
      paragraphs: [
        { lineSpacing: 72, runs: [{ text: 'Line spacing test' }] },
        { runs: [{ text: 'Automatic spacing' }] },
      ],
    });
    const health = readRp(file);
    assert.equal(health.records.unparseable, 0);
    assert.equal(health.counts.danglingRefs, 0);
    assert.equal(health.counts.problems, 0);
    const record = readRecords(file).find(item => item.className === 'Axure:Page');
    const graph = parsePayload(record);
    const widget = graph.objects.get(10);
    const paragraphs = field(field(field(widget.body, 'RichTextBlock'), 'attributed-string'), 'Paragraphs').items;
    assert.equal(field(paragraphs[0], 'LineSpacing').tag, 6);
    assert.equal(field(paragraphs[0], 'LineSpacing').value, 72);
    assert.equal(field(paragraphs[1], 'LineSpacing').value, 0);
    const style = graph.objects.get(field(widget.body, 'MyStyle').value);
    const lineSpacingProp = field(style.body, 'PropList').items.find(prop => (field(prop, 'DOAName').value & 0x0fffffff) === 20);
    assert.equal(field(lineSpacingProp, 'DOAName').value, 0x40000014);
    assert.equal(field(lineSpacingProp, 'Value').value, 72);
  });

  check('RichText paragraph lineSpacing rejects negative and non-finite values', () => {
    const source = readFileSync(fixturePath('richtext-v2-gui-edit.rp'));
    for (const lineSpacing of [-1, Infinity, NaN]) {
      assert.throws(() => setWidgetRichText(source, {
        page: 'Page 1', widget: 'RICH_TEXT',
        paragraphs: [{ lineSpacing, runs: [{ text: 'invalid spacing' }] }],
      }), /lineSpacing must be a finite nonnegative number/);
    }
  });

  check('RichText run links clone native targets and preserve linked run text', () => {
    const source = readFileSync(fixturePath('richtext-hyperlink-template.rp'));
    const { file, report } = setWidgetRichText(source, {
      page: 'Page 1', widget: 'RICH_TEXT',
      paragraphs: [
        { runs: [{ text: 'Before' }] },
        { runs: [{ text: 'Open ' }, { text: 'Page Two', link: { page: 'Page 2', window: 'current' } }] },
        { runs: [{ text: 'After' }] },
      ],
    });
    const rp = readRp(file);
    assert.equal(report.links, 1);
    assert.equal(report.text, 'Before\nOpen Page Two\nAfter');
    assert.deepEqual({ unparseable: rp.records.unparseable, danglingRefs: rp.counts.danglingRefs, problems: rp.counts.problems },
      { unparseable: 0, danglingRefs: 0, problems: 0 });
    const page = rp.pages.find(item => item.name === 'Page 1');
    const linkWidget = page.widgets.find(widget => widget.type === 'Hyperlink'
      && widget.interactions?.some(event => event.cases.some(kase => kase.actions.some(action => action.human.includes('Page 2.html')))));
    assert.ok(linkWidget, 'cloned Hyperlink widget targeting Page 2 missing');
    const original = readRecords(source).find(item => item.index === page.record);
    const originalGraph = parsePayload(original);
    const originalInline = [...originalGraph.objects.values()]
      .filter(object => object.className === 'Axure:DiagramObject:VectorShape')
      .flatMap(object => {
        const blockRef = field(object.body, 'RichTextBlock');
        const block = blockRef?.tag === 3 ? originalGraph.objects.get(blockRef.value)?.body : blockRef;
        return field(field(block ?? {}, 'attributed-string') ?? {}, 'Paragraphs')?.items ?? [];
      })
      .flatMap(paragraph => field(paragraph, 'Inlines')?.items ?? [])
      .find(inline => field(inline, 'Type')?.text === 'Axure:AttributedString:AxHyperlink');
    const originalLinkId = field(originalInline, 'Link')?.value;
    const outputPage = readRecords(file).find(item => item.index === page.record);
    const outputGraph = parsePayload(outputPage);
    const outputWidget = outputGraph.objects.get(page.widgets.find(widget => widget.name === 'RICH_TEXT').id);
    const blockRef = field(outputWidget.body, 'RichTextBlock');
    const block = blockRef?.tag === 3 ? outputGraph.objects.get(blockRef.value)?.body : blockRef;
    const paragraphs = field(field(block, 'attributed-string'), 'Paragraphs').items;
    const linkedInline = paragraphs.flatMap(paragraph => field(paragraph, 'Inlines').items)
      .find(inline => field(inline, 'Type')?.text === 'Axure:AttributedString:AxHyperlink');
    assert.equal(field(linkedInline, 'Link')?.value, linkWidget.id);
    assert.notEqual(field(linkedInline, 'Link')?.value, originalLinkId);
    assert.equal(field(field(linkedInline, 'Inlines').items[0], 'Text')?.text, 'Page Two');
  });

  check('RichText links reject missing pages and non-HTTP URL schemes', () => {
    const source = readFileSync(fixturePath('richtext-hyperlink-template.rp'));
    assert.throws(() => setWidgetRichText(source, {
      page: 'Page 1', widget: 'RICH_TEXT', paragraphs: [{ runs: [{ text: 'bad', link: { page: 'Missing' } }] }],
    }), /Expected exactly one page named/);
    assert.throws(() => setWidgetRichText(source, {
      page: 'Page 1', widget: 'RICH_TEXT', paragraphs: [{ runs: [{ text: 'bad', link: { url: 'javascript:alert(1)' } }] }],
    }), /run.link.url must use http or https/);
  });

  check('RichText paragraph list writes native ListInfo levels and preserves key order', () => {
    const source = readFileSync(fixturePath('richtext-v2-gui-edit.rp'));
    const { file } = setWidgetRichText(source, {
      page: 'Page 1', widget: 'RICH_TEXT',
      paragraphs: [
        { runs: [{ text: 'Plain' }] },
        { list: true, runs: [{ text: 'Level one' }] },
        { list: 2, runs: [{ text: 'Level two' }] },
        { list: false, runs: [{ text: 'Back to plain' }] },
      ],
    });
    const health = readRp(file);
    assert.equal(health.records.unparseable, 0);
    assert.equal(health.counts.danglingRefs, 0);
    assert.equal(health.counts.problems, 0);
    const record = readRecords(file).find(item => item.className === 'Axure:Page');
    const graph = parsePayload(record);
    const widget = graph.objects.get(10);
    const paragraphs = field(field(field(widget.body, 'RichTextBlock'), 'attributed-string'), 'Paragraphs').items;
    const expected = [[0, 0], [1, 1], [2, 1], [0, 0]];
    paragraphs.forEach((paragraph, index) => {
      const keys = paragraph.entries.map(([key]) => key.text);
      assert.deepEqual(keys, ['Wrapping', 'Trimming', 'HorizontalAlignment', 'LineSpacing', 'ListInfo', 'Inlines']);
      const listInfo = field(paragraph, 'ListInfo');
      assert.equal(field(listInfo, 'IndentLevel').tag, 5);
      assert.equal(field(listInfo, 'IndentLevel').value, expected[index][0]);
      assert.equal(field(listInfo, 'ListType').tag, 5);
      assert.equal(field(listInfo, 'ListType').value, expected[index][1]);
    });
  });

  check('RichText paragraph list rejects out-of-range levels', () => {
    const source = readFileSync(fixturePath('richtext-v2-gui-edit.rp'));
    for (const list of [4, -1, 1.5, 'bullet']) {
      assert.throws(() => setWidgetRichText(source, {
        page: 'Page 1', widget: 'RICH_TEXT', paragraphs: [{ list, runs: [{ text: 'invalid' }] }],
      }), /list must be a boolean or an integer level 0-3/);
    }
  });

  check('RichText run full-range native keys write weight/style/stretch/characterSpacing/baseline', () => {
    const source = readFileSync(fixturePath('richtext-v2-gui-edit.rp'));
    const { file } = setWidgetRichText(source, {
      page: 'Page 1', widget: 'RICH_TEXT',
      paragraphs: [{ runs: [{ text: 'Full range', style: { weight: 800, style: 2, stretch: 3, characterSpacing: 2.5, baseline: 1 } }] }],
    });
    const health = readRp(file);
    assert.equal(health.records.unparseable, 0);
    assert.equal(health.counts.danglingRefs, 0);
    assert.equal(health.counts.problems, 0);
    const record = readRecords(file).find(item => item.className === 'Axure:Page');
    const graph = parsePayload(record);
    const widget = graph.objects.get(10);
    const run = field(field(field(widget.body, 'RichTextBlock'), 'attributed-string'), 'Paragraphs').items[0];
    const inline = field(run, 'Inlines').items.find(i => field(i, 'Type')?.text === 'Axure:AttributedString:AxRun');
    assert.equal(field(inline, 'Weight').value, 800);
    assert.equal(field(inline, 'Style').value, 2);
    assert.equal(field(inline, 'Stretch').value, 3);
    assert.equal(field(inline, 'CharacterSpacing').tag, 6);
    assert.equal(field(inline, 'CharacterSpacing').value, 2.5);
    assert.equal(field(inline, 'Baseline').value, 1);
    assert.throws(() => setWidgetRichText(source, {
      page: 'Page 1', widget: 'RICH_TEXT', paragraphs: [{ runs: [{ text: 'x', style: { weight: 999 } }] }],
    }), /weight must be an integer 100-950/);
    assert.throws(() => setWidgetRichText(source, {
      page: 'Page 1', widget: 'RICH_TEXT', paragraphs: [{ runs: [{ text: 'x', style: { bold: true, weight: 700 } }] }],
    }), /bold and weight both write the native Weight key/);
  });

  check('RichText paragraph wrapping and trimming write native u32 keys', () => {
    const source = readFileSync(fixturePath('richtext-v2-gui-edit.rp'));
    const { file } = setWidgetRichText(source, {
      page: 'Page 1', widget: 'RICH_TEXT',
      paragraphs: [{ wrapping: 1, trimming: 3, runs: [{ text: 'No wrap ellipsis' }] }],
    });
    const record = readRecords(file).find(item => item.className === 'Axure:Page');
    const graph = parsePayload(record);
    const widget = graph.objects.get(10);
    const paragraph = field(field(field(widget.body, 'RichTextBlock'), 'attributed-string'), 'Paragraphs').items[0];
    assert.equal(field(paragraph, 'Wrapping').value, 1);
    assert.equal(field(paragraph, 'Trimming').value, 3);
    assert.throws(() => setWidgetRichText(source, {
      page: 'Page 1', widget: 'RICH_TEXT', paragraphs: [{ wrapping: 5, runs: [{ text: 'x' }] }],
    }), /wrapping must be an integer 0-4/);
    assert.throws(() => setWidgetRichText(source, {
      page: 'Page 1', widget: 'RICH_TEXT', paragraphs: [{ trimming: 1, runs: [{ text: 'x' }] }],
    }), /trimming must be 0/);
  });

  check('Native table cells accept {runs:[{text,style}]} multi-run objects', () => {
    const tmp = mkdtempSync(tmpdir() + '/table-multirun-');
    const spec = tmp + '/spec.json', out = tmp + '/out.rp';
    writeFileSync(spec, JSON.stringify({
      cells: [
        [{ runs: [{ text: 'H ', style: { bold: true, fontFamily: 'Courier New' } }, { text: '1', style: { bold: true, color: '#D72638' } }] }, 'plain'],
        ['a', { runs: [{ text: 'x ' }, { text: 'red', style: { color: '#FF0000' } }] }],
      ],
      rowHeights: [30, 30], columnWidths: [100, 100],
    }));
    execFileSync(process.execPath, [join(TEST_DIR, '..', 'scripts', 'set-native-table.mjs'), fixturePath('table-native-writer-roundtrip.rp'), out, spec]);
    const health = readRp(readFileSync(out));
    assert.equal(health.records.unparseable, 0);
    assert.equal(health.counts.danglingRefs, 0);
    assert.equal(health.counts.problems, 0);
    const record = readRecords(readFileSync(out)).find(item => item.className === 'Axure:Page');
    const graph = parsePayload(record);
    const table = [...graph.objects.values()].find(o => o.className === 'Axure:DiagramObject:Table');
    const cellIds = field(table.body, 'cells').items.map(n => n.value);
    const runsOf = id => {
      const cell = graph.objects.get(id);
      const rich = field(cell.body, 'RichTextBlock');
      const attr = field(rich, 'attributed-string');
      return field(field(attr ?? {}, 'Paragraphs').items[0], 'Inlines').items;
    };
    const first = runsOf(cellIds[0]);
    assert.equal(first.length, 2);
    assert.equal(field(first[0], 'Weight').value, 700);
    const fontProp = field(first[0], 'Family');
    assert.ok(fontProp, 'Family property missing');
    assert.equal(fontProp.tag, 8, 'Family property must be tag 8');
    assert.equal(typeof fontProp.value, 'number', 'Family value must be integer index');
    assert.ok(fontProp.value > 0, 'Family value must be 1-based positive index');
    assert.equal(record.strings[fontProp.value - 1], 'Courier New');
    assert.equal(fontProp.text, 'Courier New');

    assert.equal(field(first[1], 'Weight').value, 700);
    assert.equal(field(first[1], 'Color').value, 0xffd72638);
    const last = runsOf(cellIds[3]);
    assert.equal(last.length, 2);
    assert.equal(field(last[1], 'Color').value, 0xffff0000);

    // 负例 1: bold 与 weight 冲突拒绝
    const specBoldWeight = tmp + '/spec-bold-weight.json', outErr = tmp + '/out-err.rp';
    writeFileSync(specBoldWeight, JSON.stringify({
      cells: [
        [{ runs: [{ text: 'Conflict', style: { bold: true, weight: 700 } }] }, 'plain'],
        ['a', 'b'],
      ],
      rowHeights: [30, 30], columnWidths: [100, 100],
    }));
    assert.throws(() => {
      execFileSync(process.execPath, [join(TEST_DIR, '..', 'scripts', 'set-native-table.mjs'), fixturePath('table-native-writer-roundtrip.rp'), outErr, specBoldWeight], { stdio: 'pipe' });
    }, /bold and weight both write the native Weight key/);

    // 负例 2: italic 与 style 冲突拒绝
    const specItalicStyle = tmp + '/spec-italic-style.json';
    writeFileSync(specItalicStyle, JSON.stringify({
      cells: [
        [{ runs: [{ text: 'Conflict', style: { italic: true, style: 1 } }] }, 'plain'],
        ['a', 'b'],
      ],
      rowHeights: [30, 30], columnWidths: [100, 100],
    }));
    assert.throws(() => {
      execFileSync(process.execPath, [join(TEST_DIR, '..', 'scripts', 'set-native-table.mjs'), fixturePath('table-native-writer-roundtrip.rp'), outErr, specItalicStyle], { stdio: 'pipe' });
    }, /italic and style both write the native Style key/);

    rmSync(tmp, { recursive: true, force: true });
  });

  return results;
}
