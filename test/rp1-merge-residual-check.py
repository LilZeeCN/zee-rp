"""Regression tests for RP/1 source/native merge data-loss boundaries. No GUI."""
import contextlib
import copy
import io
import json
import hashlib
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import rp_language as L
import rp_decompile as D
import rp_language_cli as C

def fixture(padding=0):
    base = {
        'language': 'rp/1', 'target': 9, 'palette': {'brand': '#275B48'},
        'pages': [
            {'id': pid, 'name': pid, 'root': {
                'type': 'box', 'id': 'root', 'layout': 'stack',
                'padding': padding, 'w': 375, 'h': 500,
                'children': [{'type': 'label', 'id': 'title', 'name': 'same',
                    'text': 'old-' + pid, 'fill': '$brand',
                    'x': 10, 'y': 10, 'w': 140, 'h': 28}]}}
            for pid in ('p1', 'p2')]
    }
    _, ir = L.compile_language(copy.deepcopy(base))
    syms = [s for s in ir['symbols'] if s['id'].endswith('/title')]
    rp = {'pages': [
        {'name': p['name'], 'record': 100 + i, 'widgets': [{
            'id': 10, 'name': 'same', 'type': 'VectorShape',
            'text': 'old-' + p['id'], 'x': 10 + padding, 'y': 10 + padding,
            'w': 140, 'h': 28, 'interactions': []}]}
        for i, p in enumerate(base['pages'])]}
    meta = {'sourceMap': [{'id': s['id'], 'native': [{'record': 100+i, 'id': 10}]}
                          for i, s in enumerate(syms)]}
    return base, rp, meta

def run_merge(base, rp, edited, source, meta):
    return D.three_way_merge_rp(base, rp, edited, source, baseline_meta=meta)


class MergeResidualTests(unittest.TestCase):
    def test_source_delete_native_edit_refuses_output(self):
        b, r, m = fixture(); n, e = copy.deepcopy(b), copy.deepcopy(r)
        n['pages'][0]['root']['children'] = []
        e['pages'][0]['widgets'][0]['text'] = 'native'
        before = copy.deepcopy((b, r, e, n))
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / 'out.rp1'
            result = D.three_way_merge_rp(b, r, e, n, out_spec_path=dest, baseline_meta=m)
            self.assertEqual(result['status'], 'conflict')
            self.assertFalse(dest.exists())
        self.assertEqual((b, r, e, n), before)
        self.assertTrue(D.three_way_merge_rp(b, r, e, n, baseline_meta=m, prefer='source')['ok'])
        self.assertFalse(D.three_way_merge_rp(b, r, e, n, baseline_meta=m, prefer='native')['ok'])

    def test_source_page_delete_native_edit(self):
        b, r, m = fixture(); n, e = copy.deepcopy(b), copy.deepcopy(r)
        n['pages'].pop(0); e['pages'][0]['widgets'][0]['text'] = 'native'
        self.assertEqual(run_merge(b, r, e, n, m)['status'], 'conflict')

    def test_deletions_both_directions(self):
        b, r, m = fixture(); n, e = copy.deepcopy(b), copy.deepcopy(r)
        e['pages'][0]['widgets'] = []
        n['pages'][0]['root']['children'][0]['text'] = 'source'
        self.assertEqual(run_merge(b, r, e, n, m)['status'], 'conflict')
        n['pages'][0]['root']['children'] = []
        self.assertTrue(run_merge(b, r, e, n, m)['ok'])
        self.assertTrue(run_merge(b, r, r, n, m)['ok'])

    def added(self, edited):
        edited['pages'][1]['widgets'].append({'id': 11, 'name': 'new-note',
            'type': 'VectorShape', 'text': 'new on p2', 'x': 50, 'y': 80,
            'w': 100, 'h': 28, 'interactions': []})

    def test_native_add_page_identity(self):
        for mode in ('normal', 'reorder', 'insert', 'native-reorder'):
            with self.subTest(mode=mode):
                b, r, m = fixture(); n, e = copy.deepcopy(b), copy.deepcopy(r)
                self.added(e)
                if mode == 'reorder': n['pages'].reverse()
                if mode == 'native-reorder': e['pages'].reverse()
                if mode == 'insert':
                    pg = copy.deepcopy(n['pages'][0]); pg.update(id='p0', name='p0')
                    n['pages'].insert(0, pg)
                result = run_merge(b, r, e, n, m)
                self.assertTrue(result['ok'], result)
                locations = [p['id'] for p in result['spec']['pages']
                    if any(c.get('text') == 'new on p2' for c in p['root']['children'])]
                self.assertEqual(locations, ['p2'])

    def test_native_add_missing_page_and_unknown_container(self):
        b, r, m = fixture(); n, e = copy.deepcopy(b), copy.deepcopy(r); self.added(e)
        n['pages'].pop(1)
        self.assertEqual(run_merge(b, r, e, n, m)['status'], 'conflict')
        e['containedWidgets'] = [{'record': 101, **e['pages'][1]['widgets'][-1],
                                  'container': ['p2', 'panel(state)']}]
        self.assertEqual(run_merge(b, r, e, b, m)['status'], 'unsupported_native_changes')

    def test_coordinates_converted_once(self):
        b, r, m = fixture(20); e = copy.deepcopy(r)
        e['pages'][0]['widgets'][0].update(x=40, y=50)
        lift = D.lift_rp_into_spec(b, r, e, baseline_meta=m)
        result = run_merge(b, r, e, b, m)
        node = result['spec']['pages'][0]['root']['children'][0]
        self.assertEqual((node['x'], node['y']), (20, 30))
        self.assertEqual(lift['nativePropDeltas']['p1/title']['x']['old'], 10)
        self.assertEqual(lift['nativePropDeltas']['p1/title']['x']['nativeNew'], 40)

    def test_coordinates_same_value_and_conflict(self):
        b, r, m = fixture(20); n, e = copy.deepcopy(b), copy.deepcopy(r)
        e['pages'][0]['widgets'][0]['x'] = 40
        n['pages'][0]['root']['children'][0]['x'] = 20
        self.assertTrue(run_merge(b, r, e, n, m)['ok'])
        n['pages'][0]['root']['children'][0]['x'] = 21
        self.assertEqual(run_merge(b, r, e, n, m)['status'], 'conflict')
        n = copy.deepcopy(b); n['pages'][0]['root']['padding'] = 40
        self.assertEqual(run_merge(b, r, e, n, m)['status'], 'conflict')

    def test_nested_coordinates_and_parent_change(self):
        b, r, m = fixture(20)
        title = b['pages'][0]['root']['children'][0]
        b['pages'][0]['root']['children'] = [{'type':'box', 'id':'nest', 'layout':'stack',
            'padding': 5, 'x': 30, 'y': 30, 'w':300, 'h':200, 'children':[title]}]
        r['pages'][0]['widgets'][0].update(x=65, y=65)
        e = copy.deepcopy(r); e['pages'][0]['widgets'][0].update(x=75, y=85)
        result = run_merge(b, r, e, b, m)
        title = result['spec']['pages'][0]['root']['children'][0]['children'][0]
        self.assertEqual((title['x'], title['y']), (20, 30))
        n = copy.deepcopy(b); n['pages'][0]['root']['children'][0]['x'] = 40
        self.assertEqual(run_merge(b, r, e, n, m)['status'], 'conflict')

    def test_implicit_stack_coordinates_and_anchors(self):
        b, r, m = fixture(20); title = b['pages'][0]['root']['children'][0]
        title.pop('x'); r['pages'][0]['widgets'][0]['x'] = 20
        e = copy.deepcopy(r); e['pages'][0]['widgets'][0]['x'] = 30
        result = run_merge(b,r,e,b,m)
        self.assertEqual(result['spec']['pages'][0]['root']['children'][0]['x'],10)
        title['right'] = 10
        self.assertEqual(run_merge(b,r,e,b,m)['status'],'unsupported_native_changes')

    def test_component_shared_definition_and_arguments(self):
        b, _, _ = fixture()
        b['components'] = {'Header': {'params': {'title':'text'}, 'root':
            {'type':'box','id':'bar','fill':'$brand','w':200,'h':100,'children':[
                {'type':'label','id':'caption','text':{'$':'title'},'w':100,'h':28}]}}}
        b['pages'][0]['root']['children'] = [{'type':'use','id':'header','component':'Header','args':{'title':'old'}}]
        n = copy.deepcopy(b)
        n['pages'][0]['root']['children'][0]['args']['title'] = 'new'
        deltas = D._compute_source_prop_deltas(b,n)
        self.assertTrue(any(d.get('text',{}).get('new') == 'new' for d in deltas.values()))
        n = copy.deepcopy(b); n['components']['Header']['root']['fill'] = '#FF0000'
        self.assertTrue(any(d.get('fill',{}).get('new') == '#FF0000' for d in D._compute_source_prop_deltas(b,n).values()))

    def test_ambiguous_action_target_refused(self):
        w = {'name':'trigger','interactions':[{'event':'OnClick','cases':[{
            'hasCondition':False,'actions':[{'type':'set-rich-text','human':'设置富文本 duplicate = "ok"'}]}]}]}
        events, unsupported = D._lift_widget_events_ex(w,{'duplicate':None})
        self.assertFalse(events); self.assertTrue(unsupported)

    def color_merge(self, base, new, rp, meta, native='#FF0000', **kwargs):
        def visual(path):
            return {'__by_key__': {'100:10': {'fill': '#275B48' if path == 'base.rp' else native}}}
        with patch.object(D, 'read_rp_json', lambda _: copy.deepcopy(rp)), \
             patch.object(D, 'extract_rp_visual_props', visual):
            return D.three_way_merge_rp(base, 'base.rp', 'edited.rp', new, baseline_meta=meta, **kwargs)

    def test_effective_palette_conflict_and_same_value(self):
        b, r, m = fixture(); n = copy.deepcopy(b); n['palette']['brand'] = '#2563EB'
        result = self.color_merge(b, n, r, m)
        self.assertEqual(result['status'], 'conflict')
        self.assertEqual(result['sourceDeltas']['p1/title']['fill']['new'], '#2563EB')
        self.assertTrue(self.color_merge(b, n, r, m, native='#2563EB')['ok'])
        result = self.color_merge(b, n, r, m, prefer='native')
        self.assertEqual(result['spec']['palette']['brand'], '#2563EB')
        self.assertEqual(result['spec']['pages'][0]['root']['children'][0]['fill'], '#FF0000')

    def test_theme_and_non_dependent_properties(self):
        b, _, _ = fixture(); n = copy.deepcopy(b)
        b['pages'][1]['root']['children'][0]['fill'] = '#FFFFFF'
        n = copy.deepcopy(b); n['palette']['brand'] = '#2563EB'
        delta = D._compute_source_prop_deltas(b, n)
        self.assertNotIn('p2/title', delta)
        b.pop('palette'); n = copy.deepcopy(b); n['theme'] = 'mobile-lowfi'
        self.assertIn('p1/title', D._compute_source_prop_deltas(b, n))

    def test_plain_edits_and_conflicts(self):
        b, r, m = fixture(); n, e = copy.deepcopy(b), copy.deepcopy(r)
        e['pages'][0]['widgets'][0]['text'] = 'native'
        n['pages'][0]['root']['children'][0]['w'] = 160
        result = run_merge(b, r, e, n, m)
        self.assertTrue(result['ok']); self.assertEqual(result['spec']['pages'][0]['root']['children'][0]['w'], 160)
        n['pages'][0]['root']['children'][0]['text'] = 'native'
        self.assertTrue(run_merge(b, r, e, n, m)['ok'])
        n['pages'][0]['root']['children'][0]['text'] = 'source'
        self.assertEqual(run_merge(b, r, e, n, m)['status'], 'conflict')

    def test_conditional_and_disabled_events_refused(self):
        case = {'hasCondition': False, 'disabled': False, 'actions': [
            {'type':'set-rich-text', 'human':'设置富文本 status = "ok"'}]}
        for mode in ('plain', 'single-condition', 'missing', 'multiple', 'case-disabled', 'action-disabled', 'event-disabled'):
            with self.subTest(mode=mode):
                c = copy.deepcopy(case); ix = {'event':'OnLoad', 'cases':[c]}
                if mode == 'single-condition': c['hasCondition'] = True
                if mode == 'missing': c.pop('hasCondition')
                if mode == 'multiple': ix['cases'].append(copy.deepcopy(case))
                if mode == 'case-disabled': c['disabled'] = True
                if mode == 'action-disabled': c['actions'][0]['disabled'] = True
                if mode == 'event-disabled': ix['disabled'] = True
                events, unsupported = D._lift_widget_events_ex({'name':'w', 'interactions':[ix]}, {'status':'title'})
                self.assertEqual(bool(unsupported), mode != 'plain')
                self.assertEqual(bool(events), mode == 'plain')

    def test_cli_failure_with_and_without_output(self):
        b, r, m = fixture(); e = copy.deepcopy(r)
        e['pages'][0]['widgets'].append({'id':88, 'name':'unknown', 'type':'UnsupportedWidget', 'interactions':[]})
        for extra in ([], ['--out', 'must-not-exist.rp1']):
            with self.subTest(extra=extra), \
                 patch.object(D, 'read_rp_json', lambda p: copy.deepcopy(r if p == 'base.rp' else e)), \
                 patch.object(D, 'extract_rp_visual_props', lambda _: {}), \
                 patch.object(D, '_discover_baseline_meta', lambda _: m), \
                 patch.object(C, 'read_source', lambda _: copy.deepcopy(b)), \
                 patch.object(C, 'write_new') as sink, \
                 patch.object(sys, 'argv', ['rp_language_cli.py', 'lift-rp', '--spec','source.json', '--base-rp','base.rp', '--gui-rp','edited.rp'] + extra):
                stream = io.StringIO()
                with contextlib.redirect_stdout(stream): rc = C.main()
                self.assertEqual(rc, 1); self.assertFalse(json.loads(stream.getvalue())['ok'])
                sink.assert_not_called()


class NativeMergeResidualTests(unittest.TestCase):
    """Real RP9 binaries; intentionally never launches or controls Axure."""
    @classmethod
    def setUpClass(cls):
        cls.scripts = Path(D.__file__).resolve().parent
        cls.temp = tempfile.TemporaryDirectory(prefix='rp1-residual-native-')
        cls.folder = Path(os.environ.get('RP1_MERGE_EVIDENCE_DIR', cls.temp.name))
        cls.folder.mkdir(parents=True, exist_ok=True)
        cls.base, _, _ = fixture(20)
        for page in cls.base['pages']:
            page['root']['children'][0]['type'] = 'button'
        cls.base_rp = cls.generate(cls.base, 'base')
        cls.base_read = D.read_rp_json(cls.base_rp)
        cls.meta = json.loads(Path(str(cls.base_rp) + '.baseline.json').read_text())
        cls.ids = {s['id']: s['native'][0] for s in cls.meta['sourceMap'] if s.get('native')}

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    @classmethod
    def generate(cls, spec, name):
        source = cls.folder / (name + '.json'); source.write_text(json.dumps(spec))
        rp = cls.folder / (name + '.rp')
        command = ['node', str(cls.scripts / 'proto.mjs'), 'generate', '--spec', str(source),
                   '--out-dir', str(cls.folder / (name + '-build')), '--out-rp', str(rp)]
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode: raise RuntimeError(result.stderr + result.stdout)
        return rp

    @classmethod
    def node(cls, code, *args):
        result = subprocess.run(['node', '--input-type=module', '-e', code, *map(str,args)],
                                cwd=cls.scripts, capture_output=True, text=True)
        if result.returncode: raise RuntimeError(result.stderr + result.stdout)

    def patch_visual(self, name, props):
        out = self.folder / (name + '.rp')
        self.node(r'''
import { readFileSync, writeFileSync } from 'node:fs';
import { readRecords, encodeRecord, replaceRecord } from './rp-records.mjs';
import { parsePayload, encodePayload, field } from './parse-payload.mjs';
const [src,dst,locJson,propsJson] = process.argv.slice(1);
const loc = JSON.parse(locJson), props = JSON.parse(propsJson);
let buf = readFileSync(src);
const record = readRecords(buf).find(r => r.index === loc.record), graph = parsePayload(record);
const object = graph.objects.get(loc.id), style = graph.objects.get(field(object.body,'MyStyle').value);
for (const entry of field(style.body,'PropList').items) {
  const code = field(entry,'DOAName').value, val = field(entry,'Value');
  if (code === 3221225573) for (const [p, key] of [['x','X'],['y','Y']]) {
    if (props[p] !== undefined) { const n = field(val,key); n.value = props[p]; delete n.rawNumber; }
  }
  if (code === 3221225479 && props.fill) field(val,'fill-color').value = (0xFF000000 | parseInt(props.fill.slice(1),16)) >>> 0;
}
buf = replaceRecord(buf,record,encodeRecord(record,record.strings,encodePayload(graph.roots)));
writeFileSync(dst,buf);
''', self.base_rp, out, json.dumps(self.ids['p1/title']), json.dumps(props))
        return out

    def test_binary_coordinates_and_duplicate_display_isolation(self):
        edited = self.patch_visual('moved', {'x':40, 'y':50, 'fill':'#FF0000'})
        source = copy.deepcopy(self.base); source['pages'].reverse()
        out = self.folder / 'merged.rp'; spec = self.folder / 'merged.rp1'
        result = D.three_way_merge_rp(self.base,self.base_rp,edited,source,out_spec_path=spec,out_rp_path=out)
        self.assertTrue(result['ok'], result)
        title = result['spec']['pages'][1]['root']['children'][0]
        self.assertEqual((title['x'],title['y']), (20,30))
        meta = json.loads(Path(str(out)+'.baseline.json').read_text())
        props = D.extract_rp_visual_props(out)['__by_key__']
        lookup = {s['id']: s['native'][0] for s in meta['sourceMap'] if s.get('native')}
        value = lambda sid: props[f"{lookup[sid]['record']}:{lookup[sid]['id']}"]
        self.assertEqual((value('p1/title')['x'], value('p1/title')['y']), (40,50))
        self.assertEqual(value('p1/title')['fill'], '#FF0000')
        self.assertEqual(value('p2/title')['fill'], '#275B48')
        self.assertEqual(value('p2/title')['x'], 30)
        self.assertEqual(hashlib.sha256(out.read_bytes()).hexdigest(), meta['rpSha256'])

    def test_binary_conflicts_preserve_existing_outputs(self):
        edited = self.patch_visual('red', {'fill':'#FF0000'})
        for mode in ('palette', 'deletion'):
            n = copy.deepcopy(self.base)
            if mode == 'palette': n['palette']['brand'] = '#2563EB'
            else: n['pages'][0]['root']['children'] = []
            dest = self.folder / ('preserved-' + mode + '.rp1'); dest.write_text('unchanged')
            digest = hashlib.sha256(edited.read_bytes()).hexdigest()
            result = D.three_way_merge_rp(self.base,self.base_rp,edited,n,out_spec_path=dest)
            self.assertEqual(result['status'], 'conflict')
            self.assertEqual(dest.read_text(), 'unchanged')
            self.assertEqual(hashlib.sha256(edited.read_bytes()).hexdigest(), digest)

    def test_binary_label_padding_audit(self):
        spec = copy.deepcopy(self.base)
        for page in spec['pages']: page['root']['children'][0]['type'] = 'label'
        rp = self.generate(spec,'label-padding')
        props = D.extract_rp_visual_props(rp)
        # Label text has its own inset; the generated outer background must stay
        # at the declared stack position, and the structural gate must pass.
        backgrounds = [v for k,v in props.items() if k.startswith('bg-box-')]
        self.assertTrue(backgrounds)
        self.assertTrue(all(p['x']==30 and p['y']==30 for p in backgrounds))

    def test_binary_page_reorder_with_native_addition(self):
        spec = copy.deepcopy(self.base)
        spec['pages'][1]['root']['children'].append({'type':'button','id':'new_note','text':'new on p2',
            'x':10,'y':100,'w':140,'h':28})
        edited = self.generate(spec,'with-addition')
        source = copy.deepcopy(self.base); source['pages'].reverse()
        result = D.three_way_merge_rp(self.base,self.base_rp,edited,source)
        self.assertTrue(result['ok'],result)
        locations = [p['id'] for p in result['spec']['pages']
                     if any(c.get('text')=='new on p2' for c in p['root']['children'])]
        self.assertEqual(locations,['p2'])

    def conditional(self, name, right):
        out = self.folder / (name + '.rp')
        self.node(r'''
import { readFileSync, writeFileSync } from 'node:fs';
import { addInteractions } from './ix-actions.mjs';
const [src,dst,right] = process.argv.slice(1);
const ix = [{event:'OnClick', cases:[{when:{op:'==',left:{value:'a'},right:{value:right}}, actions:[{type:'wait',ms:1}]}]}];
writeFileSync(dst,addInteractions(readFileSync(src),{page:'p1',widget:'same'},ix,{replaceEvent:true}).file);
''', self.base_rp, out, right)
        return out

    def test_binary_condition_only_change_is_detected_and_refused(self):
        a, b = self.conditional('condition-a','a'), self.conditional('condition-b','b')
        def case(path):
            return next(w for w in D.read_rp_json(path)['pages'][0]['widgets'] if w['name']=='same')['interactions'][0]['cases'][0]
        ca, cb = case(a), case(b)
        self.assertTrue(ca['hasCondition']); self.assertNotEqual(ca['conditionHash'],cb['conditionHash'])
        self.assertEqual(ca['actions'],cb['actions'])
        result = D.three_way_merge_rp(self.base,a,b,self.base,baseline_meta=self.meta)
        self.assertEqual(result['status'],'unsupported_native_changes')
        self.assertFalse(D.three_way_merge_rp(self.base,a,b,self.base,baseline_meta=self.meta,prefer='native')['ok'])
        for extra in ([], ['--out',str(self.folder/'forbidden.rp1')]):
            command = [sys.executable,'-B',str(self.scripts/'rp_language_cli.py'),'lift-rp',
                       '--spec',str(self.folder/'base.json'),'--base-rp',str(self.base_rp),'--gui-rp',str(b),*extra]
            result = subprocess.run(command,capture_output=True,text=True)
            self.assertEqual(result.returncode,1,result.stderr)
            self.assertFalse(json.loads(result.stdout)['ok'])
        self.assertFalse((self.folder/'forbidden.rp1').exists())

    def test_binary_unconditional_action_still_lifts(self):
        out = self.folder / 'unconditional.rp'
        self.node(r'''
import {readFileSync,writeFileSync} from 'node:fs';
import {addInteractions} from './ix-actions.mjs';
const [src,dst] = process.argv.slice(1);
writeFileSync(dst,addInteractions(readFileSync(src),{page:'p1',widget:'same'},
  [{event:'OnClick',actions:[{type:'wait',ms:10}]}],{replaceEvent:true}).file);
''', self.base_rp,out)
        result = D.lift_rp_into_spec(self.base,self.base_rp,out,baseline_meta=self.meta)
        self.assertTrue(result['ok'],result)
        self.assertEqual(result['spec']['pages'][0]['root']['children'][0]['on']['click'],[{'type':'wait','ms':10}])


if __name__ == '__main__':
    unittest.main(verbosity=2)
