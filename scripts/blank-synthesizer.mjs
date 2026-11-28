import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { guidKey } from './duplicate-page.mjs';
import { encodePayload } from './parse-payload.mjs';
import { encodeManifest, encodeRecord } from './rp-records.mjs';
import { MAGIC0, MAGIC1, resolveTargetVersion } from './version.mjs';

const newGuid = () => guidKey(randomUUID().replaceAll('-', ''));
const zeroGuid = '0'.repeat(32);
// Original 1×1 white RGB PNG. RP11's editor decodes the manifest thumbnail on open.
const blankThumbnail = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC', 'base64');
const scalar = (tag, value) => ({ tag, value });
const integer = value => scalar(5, value);
const number = value => scalar(6, value);
const bool = value => scalar(0x19, value);
const ref = value => scalar(3, value);
const guid = value => scalar(0x11, value);
const list = (items = []) => ({ tag: 2, items });
const dict = (entries = []) => ({ tag: 1, entries });
const word = value => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
};

function blankRecord(version, className, packageGuid, build) {
  const strings = [];
  const textIndex = new Map();
  const string = value => {
    if (!textIndex.has(value)) textIndex.set(value, strings.push(value));
    return scalar(8, textIndex.get(value));
  };
  const fields = values => dict(Object.entries(values).map(([key, value]) => [string(key), value]));
  const object = (id, type, values) => ({ tag: 9, id, classIndex: string('Axure:' + type).value, body: fields(values) });
  const packageRef = (type, id) => ({ tag: 0x13, values: [string(type).value, id] });
  string('Axure:' + className);
  const guids = [newGuid(), packageGuid];
  const objects = build({ fields, object, packageRef, string, guids });
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0x1b, 0);
  header.writeUInt32LE(version, 4);
  header.writeUInt32LE(version === 9 ? 1 : 0, 12);
  header.writeUInt32LE(0xc351, 20);
  header.writeUInt32LE(31, 24);
  return gzipSync(encodeRecord({ raw: header }, strings, encodePayload([
    { tag: 0x1e, values: guids }, scalar(0x1a), scalar(0xf, 1), scalar(0x12, 2),
    ...objects, scalar(0x1c),
  ])));
}

const configs = [
  ['HtmlPrototypeGeneratorConfiguration', 'HTML 1'],
  ['Word2007SpecificationGeneratorConfiguration', 'Word Doc 1'],
  ['CsvAnnotationReportGeneratorConfiguration', 'CSV Report 1'],
  ['PrintConfig', 'Print 1'],
];

const solidStyleFill = ({ fields, string }, color) =>
  fields({ 'fill-type': string('solid'), 'fill-color': integer(color) });

// Default native widget properties also seed the unchecked style values in newly written widgets.
export function defaultStyleValues(version, context, styleId, typefaceId) {
  const { fields, string } = context;
  const fill = color => solidStyleFill(context, color);
  const shadow = (x, y, color) => fields({
    On: bool(false), OffsetX: number(x), OffsetY: number(y), BlurRadius: number(5), Color: integer(color), Spread: number(0),
  });
  const point = (x, y) => fields({ X: number(x), Y: number(y) });
  const props = {
    0: guid(styleId), 1: string('Arial'), 2: number(9.75), 3: integer(0), 4: integer(0), 5: bool(false),
    6: fill(0xff333333), 7: fill(0xffffffff), 8: fill(0xff797979), 9: integer(1), 10: integer(1),
    11: number(2), 12: number(2), 13: number(2), 14: number(2), 15: number(1), 16: integer(1),
    17: fields({ Start: integer(1), End: integer(1) }), 20: number(0), 21: dict(),
    27: fields({ Hash: string('') }), 30: integer(0),
    34: fields({ HorizontalAlignment: integer(0), VerticalAlignment: integer(0) }), 35: fields({ Hash: string('') }),
    50: number(0), 51: number(0), 70: number(1), 71: number(0),
    72: shadow(5, 5, 0x59000000), 73: shadow(0, 5, 0x59000000), 74: shadow(1, 1, 0xa5000000),
    80: integer(15), 81: integer(15),
    90: fields({ On: bool(false), ColorSaturation: number(1), ColorBrightness: number(0), ColorContrast: number(1), HueRotation: number(0) }),
    91: number(0), 92: integer(0), 93: integer(0), 94: number(12), 95: bool(false), 96: guid(typefaceId),
    97: fields({ IndentLevel: integer(0), ListType: integer(0) }), 101: point(0, 0),
    105: fields({ Width: number(0), Height: number(0) }), 106: integer(0), 107: integer(0),
    110: bool(true), 111: integer(1), 1001: integer(400), 1002: integer(0), 1003: integer(5),
  };
  if (version === 11) Object.assign(props, {
    108: bool(false), 109: bool(false),
    1400: fields({ Duration: number(0), Easing: integer(0) }),
    1401: fields({ ScaleX: number(1), ScaleY: number(1), TranslateX: number(0), TranslateY: number(0), Rotate: number(0) }),
    1402: point(50, 50), 1403: fields({ On: bool(false), Radius: integer(4) }), 1404: fields({ On: bool(false), Radius: integer(4) }),
  });
  return props;
}

function styleProperties(fields, values, enabled) {
  return list(Object.entries(values).map(([id, Value]) => fields({
    DOAName: integer((!enabled || enabled.has(Number(id)) ? 0xc0000000 : 0x80000000) + Number(id)),
    Value,
  })));
}

export function defaultStyleProperties(version, context, styleId, typefaceId) {
  return styleProperties(context.fields, defaultStyleValues(version, context, styleId, typefaceId));
}

// Stable identities let stock library widgets resolve the document presets they reference.
// GUID strings here are in the record's byte order.
const defaultLibraryId = '89a1f4538b16484793d409a1b736ad03';
const headingPresets = [
  ['111111119451fb4da49f67fd55eb1f88', 24],
  ['9d5ca1b3e0dd2045be40f94c8168891e', 18],
  ['5a4c7a8c9ad66943a5f7788171ac0b32', 13.5],
  ['91c895e97907c8459c0b5fe110d15a0b', 10.5],
  ['ef196b38e14bbd439b6c392ded969f89', null],
  ['139a3bfc57b5a04f98ef0a1db9aac861', 7.5],
];

function documentPresets(version, context) {
  const { fields, object, string, guids } = context;
  const libraryId = guids.push(defaultLibraryId);
  const defaults = defaultStyleValues(version, context, 20, 28);
  // Native presets record a narrower property set than the default widget style.
  const keys = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 20, 27,
    70, 71, 72, 73, 74, 80, 81, 90, 91, 92, 93, 95, 1001, 1002, 1003];
  if (version === 11) keys.push(1400, 1401, 1402, 1403, 1404);
  const presetDefaults = Object.fromEntries(keys.map(key => [key, defaults[key]]));
  const transparentTextBox = {
    7: solidStyleFill(context, 0x00ffffff),
    9: integer(0), 10: integer(0),
    11: number(0), 12: number(0), 13: number(0), 14: number(0), 15: number(0),
  };
  const make = (name, identity, properties, enabled = Object.keys(properties).map(Number)) => {
    const id = guids.push(identity);
    return object(id, 'Style', {
      LibraryId: guid(libraryId), LibraryName: string('Default'), LegacyName: string(''),
      'style-name': string(name), Id: guid(id),
      PropList: styleProperties(fields, { ...presetDefaults, ...properties }, new Set(enabled)),
      Capabilities: scalar(0x1d, 'ffffffffffffffff'), All: bool(true),
    });
  };
  return [
    ...headingPresets.map(([id, size], index) => make(`Heading ${index + 1}`, id, {
      ...transparentTextBox, 3: integer(1), ...(size !== null && { 2: number(size) }),
    })),
    make('Paragraph', '3dd48849b4800840a4a415096f1632af', transparentTextBox),
    make('Form Hint', '66d68948ade85e4c81e59863039a5cc0', { 6: solidStyleFill(context, 0xff999999) }),
    make('Form Disabled', '6223d09ba917894db0314c8c7fc75f16', {
      6: solidStyleFill(context, 0xff000000), 7: solidStyleFill(context, 0xfff0f0f0),
    }, [7]),
  ];
}

function pageRecord(version, pageGuid, styleGuid, typefaceGuid) {
  return blankRecord(version, 'Page', pageGuid, ({ fields, object, string, guids }) => {
    guids.push(zeroGuid);
    while (guids.length < 12) guids.push(newGuid());
    guids.push(styleGuid, typefaceGuid);
    const styleInfo = fields({ LibraryId: guid(3), LibraryName: string(''), Id: guid(13), Name: string('Default') });
    return [
      object(1, 'Page', {
        AdaptiveViewSetId: guid(3), AdaptiveViewSet: ref(3), diagram: ref(4), 'page-style': ref(5),
        AdaptiveStyles: list(), AdaptiveViewMatchInfos: list(), annotation: ref(6), interactionmap: ref(7),
        StyleCache: fields({
          Styles: list([fields({ Info: styleInfo, Props: defaultStyleProperties(version, { fields, string }, 13, 14) })]),
          TypefaceToFullName: list(), TypefaceToCssName: list(),
        }),
        HackLegacyContainedObjects2: bool(true),
      }),
      object(4, 'Diagram', { 'diagram-objects': list(), AnnLinkList: ref(9), 'ruler-guide-set': ref(10), GroupsClean3: bool(true) }),
      object(9, 'AnnotationTreeMap', { 'node-table': dict(), tree: ref(11) }),
      object(10, 'RulerGuideSet', { 'ruler-guides': list() }),
      object(11, 'Tree', { children: list(), tree: ref(11) }),
      object(5, 'PageStyle', {
        'BaseStyle.Name': string(''), 'style-name': string('Page style'), Id: guid(5), PropList: list(),
        Capabilities: scalar(0x1d, version === 11 ? 'ffffbfffffffffff' : 'ffffefffffffffff'), All: bool(false),
      }),
      object(6, 'Annotation', {
        'property-name-id-to-value': dict(), 'property-name-id-to-name-text': dict(),
        'annotation-field-set-type': string('PageFragment'), OwnerId: scalar(0x16, 3), StaticFields: integer(0),
      }),
      object(7, 'InteractionTreeMap', { 'node-table': dict(), tree: ref(12), PackageMode: bool(false) }),
      object(12, 'Tree', { children: list(), tree: ref(12) }),
    ];
  });
}

function documentRecord(version, page, generators, styleGuid, typefaceGuid) {
  return blankRecord(version, 'DesignDocument', newGuid(), context => {
    const { fields, object, packageRef, string, guids } = context;
    while (guids.length < 37) guids.push(newGuid());
    guids[15 - 1] = page.id;
    generators.forEach(({ id }, index) => { guids[16 + index - 1] = id; });
    guids[20 - 1] = styleGuid;
    guids[21 - 1] = zeroGuid;
    guids[28 - 1] = typefaceGuid;
    const presets = documentPresets(version, context);
    const packages = [page, ...generators];
    const configuration = (index, type = generators[index].type) => packageRef(type, 16 + index);
    const propertySet = (id, name) => [
      object(id, 'AnnotationFieldSet', { 'property-key': ref(id + 1), 'annotation-field-views': list() }),
      object(id + 1, 'PropertyKey', { 'propertykey-items': list([ref(id + 2)]), 'name-index': fields({ [name]: integer(0) }) }),
      object(id + 2, 'PropertyKeyItem', { 'property-name': ref(id + 3), 'data-type': string('Text'), 'select-list': string('') }),
      object(id + 3, 'PropertyName', { name: string(name), 'property-name-id': string(randomUUID()) }),
    ];
    return [
      object(1, 'DesignDocument', {
        'document-type': integer(1), SavedEdition: integer(1), StyleSheet: ref(3), PageStyleSheet: ref(4), GlobalVariableSet: ref(5),
        DiagramObjectAnnotationFieldSet: ref(29), PageFragmentAnnotationFieldSet: ref(33),
        PackageInfos: list(packages.map((_, i) => ref(8 + i))),
        AdaptiveViewSets: list(), sitemap: ref(13), mastermap: ref(14),
        'default-prototype-configuration-id': configuration(0),
        'generator-configuration-ids': list(generators.map(({ name }, i) => configuration(i, name))),
        'default-specification-configuration-id': configuration(1), DefaultPrintConfigId: configuration(3, generators[0].type),
        'ruler-guide-set': ref(22), UpgradedSVNFrom7Hack: bool(false),
      }),
      object(3, 'StyleSheet', {
        GuidToDuplicate: dict(), ArchivedStyles: list(), CustomStyles: list(presets.map(style => ref(style.id))), DefaultStyle: ref(20),
        LegacyTableHorz: integer(1), LegacyTableVert: integer(1),
      }),
      object(20, 'Style', {
        LibraryId: guid(21), LibraryName: string(''), LegacyName: string(''),
        'style-name': string('Default'), Id: guid(20), PropList: defaultStyleProperties(version, { fields, string }, 20, 28),
        Capabilities: scalar(0x1d, 'ffffffffffffffff'), All: bool(true),
      }),
      ...presets,
      object(4, 'PageStyleSheet', { GuidToDuplicate: dict(), ArchivedStyles: list(), PageStyles: list(), DefaultPageStyle: ref(23) }),
      object(23, 'PageStyle', {
        'BaseStyle.Name': string(''), 'style-name': string('Default'), Id: guid(20), PropList: list(),
        Capabilities: scalar(0x1d, version === 11 ? 'ffffbfffffffffff' : 'ffffefffffffffff'), All: bool(true),
      }),
      object(5, 'GlobalVariableSet', { 'global-variables': list([ref(24)]) }),
      object(24, 'GlobalVariable', { name: string('OnLoadVariable'), 'variable-id': guid(24), 'default-value': string('') }),
      ...propertySet(29, 'Note'), ...propertySet(33, 'Page Overview'),
      ...packages.map(({ type, name }, i) => object(8 + i, 'PackageInfo', {
        'package-id': packageRef(type, 15 + i), 'package-name': string(name), dependencies: list(),
        'root-panel-infos': list(), 'diagram-type': integer(0), LoadedRdoPackages: list(), LoadedScreenshotPackages: list(),
        PackageSavedVersion: fields({ Major: integer(i === 0 && version === 9 ? 9 : 0), Minor: integer(0), Build: integer(i === 0 && version === 9 ? 1 : 0), Revision: integer(0) }),
      })),
      object(13, 'SiteTreeMap', { 'node-table': dict([[ref(25), packageRef('Axure:PackageInfo', 15)]]), tree: ref(26) }),
      object(25, 'Node', { children: list(), 'parent-node': ref(26), tree: ref(26) }),
      object(26, 'Tree', { children: list([ref(25)]), tree: ref(26) }),
      object(14, 'MasterTreeMap', { 'node-table': dict(), tree: ref(27) }),
      object(27, 'Tree', { children: list(), tree: ref(27) }),
      object(22, 'RulerGuideSet', { 'ruler-guides': list() }),
    ];
  });
}

// Version history controls the editor's open/save path, independent of Load accepting the container.
const editorVersions = {
  9: { fileBuild: 1, assemblyRevision: 3754 },
  11: { fileBuild: 0, assemblyRevision: 4137 },
};

function settingsRecord(version, pageId, styleId, typefaceId) {
  const { fileBuild, assemblyRevision } = editorVersions[version];
  const modern = version === 11;
  return blankRecord(version, 'DocumentSettings', zeroGuid, context => {
    const { fields, object, string, guids } = context;
    guids.push(pageId, typefaceId, newGuid(), newGuid(), newGuid(), styleId);
    const versionHistory = (Build, Revision) => list([fields({
      Major: integer(version), Minor: integer(0), Build: integer(Build), Revision: integer(Revision),
    })]);
    const margin = number(modern ? 10 : 0.5);
    return [
      object(1, 'DocumentSettings', {
        'collasped-page-ids': list(), 'collasped-master-folder-ids': list(),
        'data-column-ids': list(), 'data-column-widths': list(),
        ...(modern && { FloatingEditorLayoutInfos: dict() }),
        'selected-tab-package-id': guid(3), 'selected-tab-object-id': guid(2),
        'open-tab-package-ids': list(modern ? [guid(2), guid(3)] : [guid(3)]),
        'open-tab-object-ids': list(modern ? [guid(2), guid(2)] : [guid(2)]),
        'dpmanager-editor-package-ids': list(), 'dpmanager-editor-object-ids': list(),
        'dpmanager-collapse-object-ids': list(), 'collasped-interaction-treeview-ids': list(),
        IsMetric: bool(modern), IsPrintPortrait: bool(true),
        PrintSize: fields({ Width: number(modern ? 210 : 8.5), Height: number(modern ? 297 : 11) }),
        PrintMargins: fields({ Left: margin, Top: margin, Right: margin, Bottom: margin }),
        PrintResolution: number(modern ? 100 / 25.4 : 100),
        CurrentAdaptiveView: guid(4), FormatPainterStyle: ref(5), 'print-settings': ref(6),
        ...(modern && { UploadedSitmapIds: list(), PrototypeDeleted: bool(false), ShowLastPublishedCurrentLinks: bool(false) }),
        PrototypeId: string(''), PrototypeName: string(''), WorkspaceName: string(''),
        LastUsedPublishAddress: string(''), LastUsedPublishHost: string(''),
        LastUsedLoginId: string('00000000-0000-0000-0000-000000000000'),
        LibraryCollapsedCategories: list(), HtmlPreviewConfigId: guid(2), AxsharePrototypeConfigId: guid(2),
        FileVersionHistory: versionHistory(fileBuild, 0), AssemblyVersionHistory: versionHistory(0, assemblyRevision),
      }),
      object(5, 'Style', {
        LibraryId: guid(2), LibraryName: string(''), LegacyName: string(''),
        'style-name': string('FormatPainterSettings'), Id: guid(7),
        PropList: defaultStyleProperties(version, context, 8, 4),
        Capabilities: scalar(0x1d, 'ffffffffffffffff'), All: bool(true),
      }),
      object(6, 'PrintSettings', {
        'margin-left': integer(0), 'margin-right': integer(0), 'margin-top': integer(0), 'margin-bottom': integer(0),
        'paper-kind': integer(0), 'paper-height': integer(0), 'paper-width': integer(0), 'paper-name': string(''),
        'paper-source': integer(0), 'paper-source-name': string(''), landscape: bool(false),
        'scale-percentage': integer(100), 'scale-type': integer(1),
      }),
    ];
  });
}

function versionPart(version) {
  const minimum = `${version}.0.0.0`;
  const message = `Open this project in Axure RP ${version} or later.`;
  return gzipSync(Buffer.from([
    '<BreakingChanges>',
    `<Change Fail="True" UseMessage="False" Beta="${version === 11}">`,
    `<Version>${minimum}</Version><Message>${message}</Message><TeamMessage>${message}</TeamMessage>`,
    '</Change></BreakingChanges>',
  ].join('\n')));
}

export function synthesizeBlankProject({ version, pageName = 'Page 1' } = {}) {
  version = resolveTargetVersion(version);
  if (typeof pageName !== 'string' || !pageName.trim()) throw new Error('Page name must not be empty');
  const page = { id: newGuid(), name: pageName, type: 'Axure:Page' };
  const styleGuid = newGuid(), typefaceGuid = newGuid();
  const generators = configs.map(([type, name]) => ({ type: 'Axure:' + type, name, id: newGuid() }));
  const manifest = { root: { children: {}, parts: {} } };
  const chunks = [];
  let length = 0;
  function append(data) {
    const offset = length;
    chunks.push(word(0), word(data.length), data);
    length += 8 + data.length;
    return offset;
  }
  for (const generator of generators) {
    const type = generator.type.slice('Axure:'.length);
    const data = blankRecord(version, type, generator.id, ({ object }) => [object(1, type, {})]);
    manifest.root.children[guidKey(generator.id)] = { parts: { package: append(data) } };
  }
  const thumbnail = append(blankThumbnail);
  manifest.root.children[guidKey(page.id)] = { parts: { thumbnail, package: append(pageRecord(version, page.id, styleGuid, typefaceGuid)) } };
  manifest.root.parts.DesignDocument = append(documentRecord(version, page, generators, styleGuid, typefaceGuid));
  manifest.root.parts[`${version}.0.0.${editorVersions[version].assemblyRevision}.version`] = append(versionPart(version));
  manifest.root.parts.DocumentSettings = append(settingsRecord(version, page.id, styleGuid, typefaceGuid));
  const header = Buffer.alloc(8);
  header[0] = MAGIC0;
  header[1] = MAGIC1;
  header.writeUInt16LE(version, 2);
  return Buffer.concat([encodeManifest(header, manifest), ...chunks]);
}
