// RP/1's rectangular scene -> editable RP 9 objects. No clipboard, GUI or cache.
import { randomBytes, createHash } from 'node:crypto';
import { readRecords, encodeRecord, replaceRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field, walkNodes } from './parse-payload.mjs';
import { detectFileVersion } from './version.mjs';

export function writeNativeScene(file, scene) {
  if (detectFileVersion(file) !== 9) throw new Error('Native scene backend requires RP 9');
  const records = readRecords(file);
  const record = records.find(r => r.className === 'Axure:Page');
  const graph = parsePayload(record), strings = [...record.strings];
  const page = [...graph.objects.values()].find(o => o.className === 'Axure:Page');
  const diagram = graph.objects.get(field(page.body, 'diagram').value);
  if (field(diagram.body, 'diagram-objects').items.length) throw new Error('Native scene requires a blank page');
  const guids = graph.roots.find(n => n.tag === 30).values;
  const nullId = guids.indexOf('0'.repeat(32)) + 1;
  const str = text => {
    let i = strings.indexOf(text);
    if (i < 0) { i = strings.length; strings.push(text); }
    return { tag: 8, value: i + 1, text };
  };
  const int = value => ({ tag: 5, value });
  const f64 = value => ({ tag: 6, value });
  const bool = value => ({ tag: 25, value });
  const ref = value => ({ tag: 3, value });
  const guid = value => ({ tag: 17, value });
  const list = items => ({ tag: 2, items });
  const map = obj => ({ tag: 1, entries: Object.entries(obj).map(([k, v]) => [str(k), v]) });
  const xy = (x, y) => map({ X: f64(x), Y: f64(y) });
  const newId = () => { guids.push(randomBytes(16).toString('hex')); return guids.length; };
  const created = [];
  const obj = (id, className, body) => {
    const n = { tag: 9, id, className, classIndex: str(className).value, body: map(body) };
    created.push(n); return n;
  };

  // Keep the complete unchecked defaults: sparse styles can render but break the editor.
  const docRecord = records.find(r => r.className === 'Axure:DesignDocument');
  const docGraph = parsePayload(docRecord);
  const doc = [...docGraph.objects.values()].find(o => o.className === 'Axure:DesignDocument');
  const sheet = docGraph.objects.get(field(doc.body, 'StyleSheet').value);
  const defaults = docGraph.objects.get(field(sheet.body, 'DefaultStyle').value);
  const docGuids = docGraph.roots.find(n => n.tag === 30).values;
  const defaultProps = structuredClone(field(defaults.body, 'PropList'));
  walkNodes([defaultProps], n => {
    if (n.tag === 8) Object.assign(n, str(n.text));
    if (n.tag === 17) {
      const value = docGuids[n.value - 1];
      let index = guids.indexOf(value) + 1;
      if (!index) { guids.push(value); index = guids.length; }
      n.value = index;
    }
  });
  for (const p of defaultProps.items) field(p, 'DOAName').value = (field(p, 'DOAName').value & 0x3fffffff) + 0x80000000;
  const color = c => {
    const channel = n => Math.max(0, Math.min(255, Math.round(n * 255)));
    return ((channel(c.a ?? 1) << 24) | (channel(c.r) << 16) | (channel(c.g) << 8) | channel(c.b)) >>> 0;
  };
  const paint = c => map({ 'fill-type': str('solid'), 'fill-color': int(c ? color(c) : 0) });
  // 渐变填充：候选编码由 GRADIENT_ENCODING 选择，用于实测 RP9 真实接受的形状
  const paintGradient = g => {
    const enc = process.env.GRADIENT_ENCODING || 'A';
    const cols = (g.colors || []).map(hex => int(color(typeof hex === 'string' ? { r: parseInt(hex.slice(1,3),16)/255, g: parseInt(hex.slice(3,5),16)/255, b: parseInt(hex.slice(5,7),16)/255, a: 1 } : hex)));
    const offs = (g.offsets || []).map(v => f64(v));
    const angle = f64(g.angle ?? 180);
    if (enc === 'A') return map({ 'fill-type': str('linearGradient'), 'fill-colors': list(cols), 'fill-offsets': list(offs), 'fill-angle': angle });
    if (enc === 'B') return map({ 'fill-type': str('linearGradient'), stops: list(cols.map((c, i) => map({ color: c, offset: offs[i] || f64(0) }))), angle });
    if (enc === 'C') return map({ 'fill-type': str('gradient'), 'fill-colors': list(cols), 'fill-offsets': list(offs), 'fill-angle': angle });
    if (enc === 'D') return map({ 'fill-type': str('linearGradient'), 'fill-colors': list(cols), 'fill-offsets': list(offs) });
    return map({ 'fill-type': str('linearGradient'), 'fill-colors': list(cols), 'fill-offsets': list(offs), 'fill-angle': angle });
  };
  function style(id, item, kind) {
    const props = kind === 'Layer' ? list([]) : structuredClone(defaultProps);
    const put = (key, value, det = true) => {
      const p = map({ DOAName: int((det ? 0xc0000000 : 0x40000000) + key), Value: value });
      const index = props.items.findIndex(n => (field(n, 'DOAName').value & 0x3fffffff) === key);
      if (index < 0) props.items.push(p); else props.items[index] = p;
    };
    const r = item.rect;
    put(101, xy(r.location.x, r.location.y));
    if (kind !== 'Layer') {
      const fillColor = item.backgroundFills?.[0]?.type === 1 ? item.backgroundFills[0].color : null;
      const strokeColor = item.strokes?.[0]?.fill?.color;
      const hasVisibleFill = Boolean(fillColor && (fillColor.a ?? 1) > 0);
      const hasVisibleStroke = Boolean(item.strokes?.length && (item.strokeThickness ?? 0) > 0 && strokeColor && (strokeColor.a ?? 1) > 0);
      put(105, map({ Width: f64(r.size.width), Height: f64(r.size.height) }));
      put(70, f64(item.opacity ?? 1));
      put(71, f64((hasVisibleFill || hasVisibleStroke) ? (item.corners?.[0] ?? 0) : 0));
      put(80, int(0)); // no phantom border sides
      put(7, item.gradient ? paintGradient(item.gradient) : paint(fillColor));
      put(8, paint(strokeColor));
      put(15, f64(item.strokes?.length ? item.strokeThickness : 0));
      put(10, int(item.textAlignment ?? 0));
      for (const key of [11, 12, 13, 14]) put(key, f64(0));
      if (item.strokes?.length) put(80, int(item.borderSides ?? 15));
      const paras = item.text?.paragraphs ?? [], p = paras[0], inlines = paras.flatMap(pr => pr.inlines ?? []), run = inlines[0];
      if (run) {
        const same = fn => inlines.every(rn => fn(rn) === fn(run));
        put(1, str(run.family), same(rn => rn.family));
        put(2, f64(run.size * 0.75), same(rn => rn.size));
        put(1001, int(run.weight), same(rn => rn.weight));
        put(1002, int(run.style ?? 0), same(rn => rn.style ?? 0));
        put(5, bool(run.underline ?? false), same(rn => Boolean(rn.underline)));
        put(95, bool(run.strikethrough ?? false), same(rn => Boolean(rn.strikethrough)));
        put(6, paint(run.textColor), same(rn => color(rn.textColor)));
        put(9, int(p.horizontalAlignment), paras.every(pr => pr.horizontalAlignment === p.horizontalAlignment));
      }
      if (kind === 'ImageBox') {
        const image = item.backgroundFills[0];
        const raw = scene.imageMap?.[image.image];
        if (typeof raw !== 'string') throw new Error(`Native image missing data: ${image.image}`);
        const bytes = Buffer.from(raw, 'base64');
        const ext = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? '.png'
          : bytes[0] === 255 && bytes[1] === 216 ? '.jpg' : null;
        if (!ext) throw new Error('Native images require embedded PNG or JPEG');
        put(27, map({ Stream: { tag: 4, value: raw }, Extension: str(ext), Hash: str(createHash('md5').update(bytes).digest('base64')) }));
      }
    }
    return obj(id, 'Axure:Style', {
      LibraryId: guid(nullId), LibraryName: str(''), LegacyName: str(''),
      'style-name': str(`MyStyle-Axure:DiagramObject:${kind}`), Id: guid(newId()),
      PropList: props, Capabilities: { tag: 29, value: kind === 'Layer' ? '0000000000080000' : kind === 'ImageBox' ? 'bffe07ff7f5bf132' : 'bfff77ff7ffbed32' },
      All: bool(kind !== 'Layer'),
    });
  }
  function richText(item, id) {
    const paragraphs = item.text.paragraphs.map(p => {
      // Coalesce identical adjacent runs instead of writing one run per character.
      const runs = [];
      for (const run of p.inlines) {
        const { text, ...attrs } = run;
        const key = JSON.stringify(attrs);
        if (runs.at(-1)?.key === key) runs.at(-1).text += text;
        else runs.push({ key, text, attrs });
      }
      return map({ HorizontalAlignment: int(p.horizontalAlignment), LineSpacing: f64(p.lineSpacing ?? 0),
        ListInfo: map({ IndentLevel: int(0), ListType: int(0) }),
        Inlines: list(runs.map(({ text, attrs: r }) => map({
          Type: str('Axure:AttributedString:AxRun'), Text: str(text), Family: str(r.family), Size: f64(r.size * 0.75),
          Weight: int(r.weight), Style: int(r.style ?? 0), Stretch: int(r.stretch ?? 5),
          Underline: bool(r.underline ?? false), Color: int(color(r.textColor)), Baseline: int(0),
          CharacterSpacing: f64(r.characterSpacing ?? 0), Strikethrough: bool(r.strikethrough ?? false),
        }))),
      });
    });
    return map({ '*type': str('rich-text-block'),
      'attributed-string': map({ Version: map({ Major: int(9), Minor: int(0), Build: int(1), Revision: int(0) }), Paragraphs: list(paragraphs) }),
      'property-dictionary': map({ type: str('rich-text-object'), 'diagram-object-label': str(item.name),
        'text-object-id': guid(id), 'parent-diagram-id': guid(diagram.id) }),
    });
  }
  function emit(item) {
    const fail = detail => { throw new Error(`Native scene ${item.name ?? item.id}: ${detail}`); };
    if (![0, 1, 2].includes(item.itemType)) fail(`unsupported itemType ${item.itemType}`);
    if (item.rotation || item.textRotation || item.effects?.length || item.textShadows?.length || item.paths?.length || item.isMask || item.flippedHorizontal || item.flippedVertical)
      fail('unsupported transform, effect or path');
    const r = item.rect;
    if (!r || ![r.location?.x, r.location?.y, r.size?.width, r.size?.height].every(Number.isFinite)) fail('invalid rectangle');
    const group = item.itemType !== 1;
    const children = group ? [...(item.itemType === 2 && item.backgroundShape ? [item.backgroundShape] : []), ...(item.scene?.items ?? [])] : [];
    if (!group) {
      if (item.type !== 0 || (item.corners ?? []).some(n => n !== item.corners[0])) fail('only rectangular shapes with uniform radius are supported');
      const allowGradient = Boolean(item.gradient);
      if (item.backgroundFills?.length > 1 || item.strokes?.length > 1 || (item.backgroundFills ?? []).some(p => (!allowGradient && ![1, 3].includes(p.type)) || p.enabled === false)) fail('unsupported fill');
      if ((item.strokes ?? []).some(s => s.fill?.type !== 1) || item.textPadding?.length) fail('unsupported stroke or padding');
    }
    const kind = group ? 'Layer' : item.backgroundFills?.[0]?.type === 3 ? 'ImageBox' : 'VectorShape';
    const id = newId(), styleId = newId();
    const body = {
      ...(kind === 'VectorShape' ? { ControlPoints: list([]), Shape: int(0), 'reference-page-package-id': { tag: 19, values: [1, nullId] } } : {}),
      'name-block': map({ '*type': str('text-block'), text: str(item.name),
        'property-dictionary': map({ type: str('label'), 'diagram-object-id': guid(id), 'parent-diagram-id': guid(diagram.id) }) }),
      tooltip: str(''), IsContained: bool(false), IsLocked: bool(item.isLocked ?? false), SelectedStyleGroup: str(''),
      MyStyle: ref(styleId), AdaptiveStyles: list([]), SubmitButton: ref(nullId),
      Disabled: bool(false), Selected: bool(false), VisibleFromSettings: bool(item.visible !== false),
    };
    const widget = obj(id, `Axure:DiagramObject:${kind}`, body);
    style(styleId, item, kind);
    field(diagram.body, 'diagram-objects').items.push(ref(id));
    if (group) widget.body.entries.push([str('DiagramObjects'), list(children.map(child => ref(emit(child))))], [str('Propagate'), bool(false)]);
    else {
      if (item.text) widget.body.entries.push([str('RichTextBlock'), richText(item, id)]);
      widget.body.entries.push([str('AutoFitHeight'), bool(false)], [str('AutoFitWidth'), bool(false)]);
      if (kind === 'ImageBox') widget.body.entries.push([str('PreserveCornersRectangle'), map({ X: f64(0), Y: f64(0), Width: f64(0), Height: f64(0) })], [str('fit-to-image'), bool(false)]);
    }
    return id;
  }
  if (Object.keys(scene.masters ?? {}).length) throw new Error('Native scene does not support masters');
  for (const item of scene.scene?.items ?? []) emit(item);
  graph.roots.splice(graph.roots.length - 1, 0, ...created);
  return replaceRecord(file, record, encodeRecord(record, strings, encodePayload(graph.roots)));
}
