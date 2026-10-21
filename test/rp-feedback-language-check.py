"""Regression contracts for the 2026-10-19 independent acceptance findings."""
import copy
import json
import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from rp_language import compile_language, LanguageError, ReferenceRuntime, explore_state_space, patch_spec, complete_spec, explain_spec


def spec(children=None):
    return {'language':'rp/1','target':9,'theme':'enterprise-light','domain':'web',
            'variables':{'hit':''}, 'pages':[{'id':'main','root':{'column':'root','children':children or []}}]}


def searchable(filters=None):
    s=spec([{'type':'searchable-list','id':'list','dataset':'books','searchField':'title','filterField':'cat',
             'filters': filters or ['全部','CS'], 'template':{'label':'title','text':'${item.title}'}}])
    s['datasets']={'books':[{'id':'1','title':'Compilers','cat':'CS'},{'id':'2','title':'History','cat':'Other'},{'id':'3','title':'Compilers','cat':'Other'}]}
    return s


def row_ids(rt):
    return [row['id'] for rows in rt.snapshot()['repeaters'].values() for row in rows]


class FeedbackContracts(unittest.TestCase):
    def rejects(self, call, code, pointer=None):
        with self.assertRaises(LanguageError) as caught: call()
        self.assertEqual(caught.exception.diagnostic['code'], code)
        if pointer is not None:self.assertEqual(caught.exception.diagnostic['pointer'],pointer)

    def test_patch_strict_array_indices_and_missing_replace(self):
        s=spec([{'label':'first','text':'One'},{'label':'last','text':'Two'}]); before=copy.deepcopy(s)
        for op, suffix in [('replace','-1/text'),('add','99'),('replace','99'),('remove','oops'),('replace','01/text'),('remove','-')]:
            with self.subTest(op=op,path=suffix):
                path='/pages/0/root/children/'+suffix
                self.rejects(lambda:patch_spec(s,[{'op':op,'path':path,'value':'bad'}]),'E_PATCH',path)
        self.rejects(lambda:patch_spec(s,[{'op':'replace','path':'/pages/0/root/missing','value':1}]),'E_PATCH','/pages/0/root/missing')
        added=patch_spec(s,[{'op':'add','path':'/pages/0/root/children/-','value':{'label':'new','text':'New'}}])
        self.assertEqual(len(added['spec']['pages'][0]['root']['children']),3)
        self.assertEqual(s,before)

    def test_patch_changes_actual_node_and_behavior(self):
        s=spec([{'button':'title','text':'Old','onClick':{'set':{'$hit':'old'}}}])
        result=patch_spec(s,[{'path':'/pages/0/root/children/0/text','value':'New'}])
        self.assertIn('main/title',result['diff']['changedSymbols'])
        self.assertIn('main/title',result['diff']['propertyChangedSymbols'])
        result=patch_spec(s,[{'path':'/pages/0/root/children/0/onClick/set/$hit','value':'new'}])
        self.assertIn('main/title',result['diff']['behaviorChangedSymbols'])

    def test_macro_unknown_properties_and_numeric_diagnostics(self):
        for node, code, suffix in [
            ({'type':'kv-list','id':'kv','rowHieght':99,'items':[{'label':'Name','value':'Alice'}]},'E_PROPERTY','rowHieght'),
            ({'type':'kv-list','id':'kv','rowHeight':'24','items':[{'label':'Name','value':'Alice'}]},'E_TYPE','rowHeight'),
            ({'type':'form-card','id':'form','fields':[{'id':'name','h':'hug'}]},'E_TYPE','fields/0/h'),
            ({'type':'form-card','id':'form','fields':[{'id':'name','lable':'Name'}]},'E_PROPERTY','fields/0/lable'),
            ({'type':'data-table','id':'tbl','dataset':'books','columns':[{'field':'title','widht':20}]},'E_PROPERTY','columns/0/widht'),
            ({'type':'searchable-list','id':'list','dataset':'books','searchField':'title','filters':[{'label':'A','vale':'A'}],'template':{'label':'title','text':'x'}},'E_PROPERTY','filters/0/vale')]:
            with self.subTest(node=node):
                s=spec([node]);s['datasets']={'books':[{'id':'1','title':'A'}]}
                self.rejects(lambda:compile_language(s),code,'/pages/0/root/children/0/'+suffix)

    def test_macro_events_preserved_or_rejected(self):
        s=spec([{'type':'form-card','id':'form','fields':[{'id':'name'}],'onLoad':{'set':{'@name':'Loaded'}}}])
        rt=ReferenceRuntime(s)
        self.assertEqual(rt.widgets[rt.resolve_trigger_name('name')]['text'],'Loaded')
        s['pages'][0]['root']['children'][0]['onChange']={'set':{'$hit':'bad'}}
        self.rejects(lambda:compile_language(s),'E_EVENT_TARGET','/pages/0/root/children/0/onChange')

    def test_macro_source_pointers_exist(self):
        s=searchable();_,ir=compile_language(s)
        for sym in ir['symbols']:
            obj=s
            for part in sym['pointer'].strip('/').split('/'):
                key=part.replace('~1','/').replace('~0','~');obj=obj[int(key)] if isinstance(obj,list) else obj[key]
        filtered=next(sym for sym in ir['symbols'] if sym['id']=='main/list_filter_1')
        self.assertEqual(filtered['pointer'],'/pages/0/root/children/0/filters/1')
        self.assertEqual(filtered['source']['macroPointer'],'/pages/0/root/children/0')
        self.assertTrue(explain_spec(s,'main/list_filter_1')['provenance'])

    def test_literal_categories_and_combined_filter(self):
        for value in ["O'Reilly",'A "quote"',r'A\B','中文']:
            s=searchable(['全部',{'label':'Value','value':value}]);s['datasets']['books'][0]['cat']=value
            rt=ReferenceRuntime(s);rt.trigger('list_filter_1');self.assertEqual(row_ids(rt),['1'])
        s=searchable();rt=ReferenceRuntime(s);rt.trigger('list_filter_1');rt.set_input('list_search','Compilers');rt.set_input('list_search','')
        self.assertEqual(row_ids(rt),['1'])
        rt=ReferenceRuntime(s);rt.set_input('list_search','Compilers');rt.trigger('list_filter_1');rt.trigger('list_filter_0')
        self.assertEqual(row_ids(rt),['1','3'])
        # The same combined predicate is emitted to native lowering; no clear-all action remains.
        _,ir=compile_language(s)
        for ix in ir['pages'][0]['interactions']:
            for ev in ix['events']:
                for case in ev['cases']:
                    self.assertFalse(any(a['type']=='data-clear-filter' for a in case['actions']))

    def test_macro_instances_private_state_isolated(self):
        s=searchable();second=copy.deepcopy(s['pages'][0]['root']['children'][0]);second['id']='other';second['template']['label']='otherTitle'
        s['pages'][0]['root']['children'].append(second)
        rt=ReferenceRuntime(s);rt.trigger('list_filter_1');rt.set_input('other_search','History')
        reps=rt.snapshot()['repeaters']; names={sym['id']:sym['name'] for sym in rt.ir['symbols']}
        self.assertEqual([r['id'] for r in reps[names['main/list']]],['1'])
        self.assertEqual([r['id'] for r in reps[names['main/other']]],['2'])

    def test_completion_partial_local_and_invalid_pointer(self):
        s=spec([{}, {'type':'repeater','id':'rows','dataset':'books','template':{'label':'title','text':'${item.title}'}}]);s['datasets']={'books':[{'id':'1','title':'A'}]}
        c=complete_spec(s,'/pages/0/root/children/0');self.assertIn('button',c['nodeKinds']);self.assertEqual(c['rowFields'],[])
        c=complete_spec(s,'/pages/0/root/children/1/template');self.assertIn('item.title',c['rowFields'])
        self.rejects(lambda:complete_spec(s,'/pages/99/root'),'E_POINTER','/pages/99/root')

    def test_load_coverage_comes_from_executed_cases(self):
        s=spec();s['pages'][0]['on']={'load':{'cases':[{'when':False,'actions':[{'set':{'$hit':'BAD'}}]},{'else':True,'actions':[{'set':{'$hit':'GOOD'}}]}]}}
        report=explore_state_space(s,max_depth=0)
        self.assertEqual(report['states'][0]['snapshot']['variables']['hit'],'GOOD')
        self.assertEqual(report['coverage']['cases'],{'covered':1,'total':2})
        self.assertEqual(report['executionTrace'][0]['event'],'OnLoad')
        self.assertEqual(report['executionTrace'][0]['case'],1)

    def test_inactive_panel_and_hidden_ancestor_not_clickable(self):
        s=spec([{'type':'dynamic-panel','id':'panel','states':[{'id':'ready','root':{'box':'body','children':[]}},{'id':'secret','root':{'button':'unreachable','text':'Secret','onClick':{'set':{'$hit':'BAD'}}}}]}, {'box':'group','children':[{'button':'nested','text':'Nested','onClick':{'set':{'$hit':'BAD'}}}]}, {'button':'hideGroup','text':'Hide','onClick':{'hide':'group'}}])
        rt=ReferenceRuntime(s);self.assertEqual(rt.trigger('unreachable'),[]);rt.trigger('hideGroup');self.assertEqual(rt.trigger('nested'),[])
        report=explore_state_space(s,max_depth=1)
        self.assertFalse(any(st['snapshot']['variables']['hit']=='BAD' and st['path'][-1].get('target')==rt.resolve_trigger_name('unreachable') for st in report['states'] if st['path']))

    def test_empty_row_has_no_clickable_template(self):
        s=spec([{'type':'repeater','id':'rows','dataset':'books','template':{'button':'rowButton','text':'Row','onClick':{'set':{'$hit':'BAD'}}}}]);s['models']={'Book':{'id':'text'}};s['datasets']={'books':{'model':'Book','rows':[]}}
        rt=ReferenceRuntime(s);self.assertEqual(rt.trigger('rowButton'),[])
        report=explore_state_space(s,max_depth=1);self.assertEqual(report['coverage']['cases']['covered'],0)

    def test_bfs_execution_state_retains_sort_and_reports_bounds(self):
        s=spec([{'type':'repeater','id':'rows','dataset':'records','key':'id','rowHeight':24,'template':{'label':'title','text':'${item.id}'}},{'button':'sort','text':'Sort','onClick':{'type':'data-sort','target':'rows','column':'qty','direction':'ascending'}},{'button':'add','text':'Add','onClick':[{'type':'data-add','target':'rows','rows':[{'id':'3','qty':0}]},{'hide':'sort'}]}]);s['datasets']={'records':[{'id':'1','qty':1},{'id':'2','qty':2}]}
        rt=ReferenceRuntime(s);rt.trigger('sort');rt.trigger('add');goal=rt.snapshot()
        report=explore_state_space(s,max_depth=2,max_states=100)
        self.assertTrue(any(st['snapshot']==goal for st in report['states']))
        self.assertTrue(report['limitations']['depthBoundReached'])
        self.assertEqual(report['limitations']['rowSampleLimit'],2)
        self.assertEqual(report['limitations']['inputSampleLimit'],2)

    def test_actual_nested_item_shadowing_and_explicit_param(self):
        s=spec([{'use':'Host','id':'host','args':{'item':{'id':'1','title':'Lexical'}}}])
        s['models']={'Book':{'id':'text','title':'text'}};s['datasets']={'books':{'model':'Book','rows':[{'id':'1','title':'Lexical'},{'id':'2','title':'Runtime'}]}}
        s['components']={'Host':{'params':{'item':'Book'},'root':{'column':'hostBody','children':[{'label':'outside','text':'${item.title}'},{'type':'repeater','id':'rows','dataset':'books','template':{'row':'line','children':[{'label':'implicit','text':'${item.title}'},{'label':'explicitRow','text':'${row.title}'},{'label':'explicitParam','text':'${param.item.title}'}]}}]}}}
        lowered,ir=compile_language(s);root=lowered['pages'][0]['root']['children'][0]
        self.assertEqual(root['children'][0]['text'],'Lexical')
        template=root['children'][1]['template']
        self.assertEqual(template['children'][2]['text'],'Lexical')
        bindings=[a['runtime'] for ix in ir['pages'][0]['interactions'] for ev in ix['events'] for c in ev['cases'] for a in c['actions'] if a.get('type')=='set-text' and 'runtime' in a]
        self.assertEqual(sum(a.get('kind')=='item' and a.get('field')=='title' for a in bindings),2)

    def test_component_and_compile_repeat_macro_identity(self):
        s=searchable();macro=s['pages'][0]['root']['children'][0]
        s['models']={'Entry':{'id':'text'}};s['datasets']['instances']={'model':'Entry','rows':[{'id':'a'},{'id':'b'}]}
        s['components']={'List':{'params':{},'root':macro}}
        s['pages'][0]['root']['children']=[{'repeat':'instances','dataset':'instances','template':{'use':'List','id':'instance'}}]
        _,ir=compile_language(s)
        private=[name for name in ir['variables'] if name.startswith('rp1_filter_')]
        self.assertEqual(len(private),2)
        writes={a['variable'] for p in ir['pages'] for ix in p['interactions'] for e in ix['events'] for c in e['cases'] for a in c['actions'] if a['type']=='set-variable'}
        self.assertEqual(writes,set(private))

    def test_page_event_conflicts_and_paragraph_bounds(self):
        for on in (None,[],{'load':[]},{'OnLoad':[]}):
            s=spec();s['pages'][0].update(on=on,onLoad={'set':{'$hit':'good'}})
            self.rejects(lambda:compile_language(s),'E_EVENT')
        for prop,value in [('lineHeight',0),('lineHeight',-1),('lineGap',-1)]:
            s=spec([{'paragraph':'text','text':'Text',prop:value}])
            self.rejects(lambda:compile_language(s),'E_SIZE','/pages/0/root/children/0/'+prop)

    def test_reference_limits_unknown_targets_and_derived_trace(self):
        s=spec([{'input':'entry','value':''},{'label':'result','text':'${@entry}'}]);rt=ReferenceRuntime(s)
        self.rejects(lambda:rt.trigger('missing'),'E_REFERENCE')
        self.rejects(lambda:rt.set_input('result','bad'),'E_TARGET_TYPE')
        rt.set_input('entry','Changed')
        self.assertTrue(any(t['event']=='OnTextChange' and t['reason']=='input-change' for t in rt.execution_trace))
        s=spec();s['pages'][0]['onLoad']={'goto':'main'}
        self.rejects(lambda:ReferenceRuntime(s),'E_RUNTIME_LIMIT')

if __name__=='__main__':unittest.main(verbosity=2)
