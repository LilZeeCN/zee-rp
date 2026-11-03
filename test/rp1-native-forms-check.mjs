// RP/1 native forms: compiler, reference behavior and actual RP9 serialization.
// Native browser behavior is verified separately after Axure save/reopen.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRp } from '../scripts/rp-read.mjs';
import { readRecords } from '../scripts/rp-records.mjs';
import { field, parsePayload } from '../scripts/parse-payload.mjs';
import { nativeTemplateSkipReason } from './host-capabilities.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'examples/rp-language/native-forms.rp1');
const work = mkdtempSync(join(tmpdir(), 'rp1-native-forms-check-'));
let checks = 0;
const check = (name, run) => { run(); checks++; console.log('PASS ' + name); };
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, (result.stderr || '') + result.stdout);
  return JSON.parse(result.stdout);
};

try {
  const semantics = run('python3', ['-c', `
import copy,json,sys
sys.path.insert(0,${JSON.stringify(join(root, 'scripts'))})
from rp_language_cli import read_source
from rp_language import compile_language,ReferenceRuntime,LanguageError
source=read_source(${JSON.stringify(source)})
lowered,ir=compile_language(source)
rt=ReferenceRuntime((lowered,ir))
def name(logical):
    return next(s['name'] for s in ir['symbols'] if s['id']==logical)
def state(logical):
    return copy.deepcopy(rt.widgets[name(logical)])
def click(logical):
    rt.trigger(logical,'click')
def visible(ids):
    return {i:state('query/'+i)['visible'] for i in ids}
assert state('tabs/tab_0')['selected'] is True
click('tabs/tab_2')
assert state('tabs/tab_2')['selected'] is True
assert state('tabs/tab_0')['selected'] is False
assert state('tabs/tab_content')['text']=='详情内容'
tabs=[state('tabs/tab_'+str(i))['selected'] for i in range(3)]
click('tabs/next')
rt.trigger('input/search','focus')
assert state('input/clear')['visible'] is True
click('input/clear')
assert state('input/search')['text']==''
assert state('input/clear')['visible'] is False
click('input/disable_search')
assert state('input/search')['enabled'] is False
rt.set_input('input/search','blocked')
assert state('input/search')['text']==''
click('input/enable_search')
assert state('input/search')['enabled'] is True
rt.set_input('input/search','恢复输入')
click('input/next')
click('query/query')
items=['item_a','item_b','item_c']
assert visible(items)==dict.fromkeys(items,True)
rt.set_input('query/seller_self',True)
assert state('query/seller_all')['checked'] is False
rt.set_input('query/shipping',True)
rt.set_input('query/discount',True)
rt.set_input('query/price','0-50')
click('query/query')
assert visible(items)=={'item_a':True,'item_b':False,'item_c':False}
assert '包邮=true' in state('query/result')['text']
assert '价格=0-50' in state('query/result')['text']
match=state('query/result')['text']
rt.set_input('query/seller_third',True)
click('query/query')
assert not any(visible(items).values())
assert state('query/empty')['visible'] is True
click('query/reset')
assert state('query/seller_all')['checked'] is True
assert state('query/seller_self')['checked'] is False
assert state('query/seller_third')['checked'] is False
assert state('query/shipping')['checked'] is False
assert state('query/discount')['checked'] is False
assert state('query/price')['text']=='全部价格'
assert not any(visible(items).values())
assert state('query/empty')['visible'] is False
assert state('query/result')['text']=='请选择条件后点击查询'
click('query/next')
assert state('lists/single')['text']=='绿'
assert state('lists/multi')['selectedIndices']==[0,2]
click('lists/choose')
assert state('lists/selection')['text']=='蓝 / 乙'
def invalid(node,code):
    spec={'language':'rp/1','target':9,'pages':[{'id':'p','root':{'type':'box','id':'root','children':[node]}}]}
    try: compile_language(spec)
    except LanguageError as error:
        assert error.diagnostic['code']==code,error.diagnostic
        return error.diagnostic['code']
    raise AssertionError('Invalid form was accepted: '+repr(node))
negative={
 'bad_checked':invalid({'type':'checkbox','id':'c','checked':'yes'},'E_TYPE'),
 'empty_options':invalid({'type':'combobox','id':'c','options':[]},'E_OPTIONS'),
 'bad_index':invalid({'type':'listbox','id':'c','options':['A'],'selectedIndex':2},'E_OPTIONS'),
 'conflicting_checked_selected':invalid({'type':'checkbox','id':'c','checked':True,'selected':False},'E_PROPERTY'),
}
peer_spec={'language':'rp/1','target':9,'variables':{'changed':{'type':'boolean','value':False}},'pages':[{'id':'peer','root':{'type':'box','id':'root','children':[
 {'type':'radio','id':'a','group':'g','checked':True,'onChange':[{'type':'set-variable','variable':'changed','value':True}]},
 {'type':'radio','id':'b','group':'g','checked':False},
]}}]}
peer=ReferenceRuntime(peer_spec)
peer.trigger('peer/b','click')
assert peer.variables['changed'] is True, 'A deselected radio peer must receive OnSelectedChange'
selected_only_spec={'language':'rp/1','target':9,'pages':[{'id':'selected_only','root':{'type':'box','id':'root','children':[
 {'type':'checkbox','id':'check','selected':True},
]}}]}
selected_only=ReferenceRuntime(selected_only_spec)
selected_widget=next(widget for widget in selected_only.widgets.values() if widget['kind']=='checkbox')
assert selected_widget['checked'] is True and selected_widget['selected'] is True
boundaries={'radio_peer_change':peer.variables['changed'],'selected_only_checked':selected_widget['checked']}
print(json.dumps({'symbols':ir['symbols'],'tabs':tabs,'query':match,'negative':negative,'boundaries':boundaries,'pages':len(ir['pages'])},ensure_ascii=False))
`]);
  check('RP/1 native form reference behavior, selection groups, query and reset', () => {
    assert.deepEqual(semantics.tabs, [false, false, true]);
    assert.equal(semantics.pages, 4);
    assert.equal(Object.keys(semantics.negative).length, 4);
  });
  check('radio peer callbacks and checked/selected initialization stay consistent', () => {
    assert.equal(semantics.boundaries.radio_peer_change, true);
    assert.equal(semantics.boundaries.selected_only_checked, true);
    assert.equal(semantics.negative.conflicting_checked_selected, 'E_PROPERTY');
  });

  const skip = nativeTemplateSkipReason();
  if (skip) {
    console.log(JSON.stringify({ ok: true, checks, native: 'skipped', reason: skip }));
  } else {
    const output = join(work, 'native-forms.rp');
    const generation = run('node', [join(root, 'scripts/proto.mjs'), 'generate', '--spec', source,
      '--out-dir', join(work, 'bundle'), '--out-rp', output]);
    const bytes = readFileSync(output);
    const summary = readRp(bytes, { path: output });
    const contexts = readRecords(bytes).filter(r => ['Axure:Page', 'Axure:PanelState'].includes(r.className))
      .map(record => ({ record, graph: parsePayload(record) }));
    const names = new Map(semantics.symbols.map(s => [s.id, s.name]));
    const widget = logical => {
      const name = names.get(logical);
      for (const context of contexts) {
        for (const object of context.graph.objects.values()) {
          if (object.className.startsWith('Axure:DiagramObject:') && field(field(object.body, 'name-block') ?? {}, 'text')?.text === name)
            return { ...context, object };
        }
      }
      assert.fail('Missing native widget ' + logical + ' / ' + name);
    };
    check('RP9 native output contains every required form type and has three zeros', () => {
      assert.equal(summary.pages.length, 4);
      for (const [key, type] of [['input/search', 'TextBox'], ['query/seller_all', 'RadioButton'],
        ['query/shipping', 'Checkbox'], ['query/price', 'ComboBox'], ['lists/single', 'ListBox'], ['lists/alias', 'ComboBox']])
        assert.equal(widget(key).object.className, 'Axure:DiagramObject:' + type, key);
      for (const key of ['danglingRefs', 'sentinelSlotsNonZero', 'problems']) assert.equal(summary.counts[key], 0, key);
      assert.equal(generation.ok, true);
      assert.equal(generation.rpBuilt.backend, 'native');
      assert.equal(generation.rpBuilt.eventCoverage.materialized, generation.rpBuilt.eventCoverage.declared);
      for (const symbol of generation.rpBuilt.sourceMap.filter(symbol => ['input', 'radio', 'checkbox', 'combobox', 'listbox'].includes(symbol.kind)))
        assert.equal(symbol.native.length, 1, symbol.id);
    });
    check('native input stays before its clear button in IDs, definitions and parent layer', () => {
      const input = widget('input/search'), clear = widget('input/clear');
      assert.equal(input.record.index, clear.record.index);
      assert.ok(input.object.id < clear.object.id, 'Native input object ID must precede the clear button');
      const definitions = [...input.graph.objects.keys()];
      assert.ok(definitions.indexOf(input.object.id) < definitions.indexOf(clear.object.id),
        'Native input definition must precede the clear button definition');
      const layers = [...input.graph.objects.values()].filter(object => object.className === 'Axure:DiagramObject:Layer');
      const owner = layers.find(layer => {
        const children = field(layer.body, 'DiagramObjects')?.items.map(item => item.value) ?? [];
        return children.includes(input.object.id) && children.includes(clear.object.id);
      });
      assert.ok(owner, 'Native input and clear button must retain their shared parent Layer');
      const siblings = field(owner.body, 'DiagramObjects').items.map(item => item.value);
      assert.ok(siblings.indexOf(input.object.id) < siblings.indexOf(clear.object.id));
      const mapping = generation.rpBuilt.sourceMap.find(symbol => symbol.id === 'input/search').native[0];
      assert.equal(mapping.id, input.object.id);
      assert.equal(mapping.record, input.record.index);
    });
    check('checked state, radio groups, list options and multi-selection are native fields', () => {
      const all = widget('query/seller_all'), self = widget('query/seller_self');
      assert.equal(field(all.object.body, 'Selected').value, true);
      assert.equal(field(self.object.body, 'Selected').value, false);
      assert.equal(field(all.object.body, 'radio-group').text, field(self.object.body, 'radio-group').text);
      assert.ok(field(all.object.body, 'radio-group').text);
      const { graph, object } = widget('lists/multi');
      assert.equal(field(object.body, 'multiple').value, true);
      const options = field(object.body, 'list-options').items.map(item => graph.objects.get(item.value));
      assert.deepEqual(options.map(option => field(option.body, 'object').text), ['一', '二', '三']);
      assert.deepEqual(options.map(option => field(option.body, 'selected').value), [true, false, true]);
    });
    check('style state maps reference real native styles on tabs and the text field', () => {
      const states = logical => {
        const { graph, object } = widget(logical);
        const style = graph.objects.get(field(object.body, 'MyStyle').value);
        const props = field(style.body, 'PropList').items;
        const map = field(props.find(prop => (field(prop, 'DOAName').value & 0x3fffffff) === 21), 'Value');
        assert.ok(map, logical + ' missing native state-style map');
        for (const [, value] of map.entries) assert.equal(graph.objects.get(value.value)?.className, 'Axure:Style');
        return map.entries.map(([key]) => key.text);
      };
      assert.ok(states('tabs/tab_0').includes('MouseOver'));
      assert.ok(states('tabs/tab_0').includes('Selected'));
      assert.ok(states('input/search').includes('Focused'));
    });
    check('compiled interactions use native checked and option getter functions', () => {
      const calls = contexts.flatMap(({ graph }) => [...graph.objects.values()])
        .filter(object => object.className === 'Axure:Expr:FCall')
        .map(object => field(object.body, 'function-name')?.text);
      for (const fn of ['GetCheckState', 'GetSelectedOption', 'SetCheckState', 'SetSelectedOption']) assert.ok(calls.includes(fn), fn);
      const allWidgets = summary.pages.flatMap(page => page.widgets);
      const events = logical => allWidgets.find(w => w.name === names.get(logical)).interactions.map(ix => ix.event);
      assert.ok(events('query/price').includes('OnSelectionChange'));
      assert.ok(events('query/shipping').includes('OnSelectedChange'));
    });
    console.log(JSON.stringify({ ok: true, checks, evidence: 'compiler-reference-model-and-native-serialization',
      nativeGui: 'requires separate Axure save/reopen and browser verification' }));
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
