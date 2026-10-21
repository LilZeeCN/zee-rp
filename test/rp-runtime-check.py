"""Public language contract: positive programs, isolation and rejected programs."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from rp_language import compile_language, LanguageError, Frontend
from rp_schema import language_schema


def fixture():return json.loads((ROOT/'examples/rp-language/runtime-inventory.json').read_text())
def node(spec,nid):
    def walk(n):
        if n.get('id')==nid:return n
        for c in n.get('children',[])+[s['root'] for s in n.get('states',[])]+([n['template']] if 'template' in n else []):
            found=walk(c)
            if found:return found
    return walk(spec['pages'][0]['root'])
checks=0

def check(name,run):
    global checks
    run();checks+=1;print('PASS',name)

def reject(name,mutate,code):
    def run():
        spec=fixture();mutate(spec)
        try:compile_language(spec)
        except LanguageError as error:
            assert error.diagnostic['code']==code,(name,error.diagnostic)
            assert error.diagnostic['pointer'].startswith('/')
        else:raise AssertionError(name+' was accepted')
    check(name,run)

for p in sorted((ROOT/'examples/rp-language').glob('*.json')):
    def program(p=p):
        source=json.loads(p.read_text());_,ir=compile_language(source)
        assert ir['irVersion']==2 and ir==compile_language(source)[1]
    check('deterministic '+p.name,program)

def set_text(nid,value):return lambda s:node(s,nid).__setitem__('text',value)
def set_action(nid,key,value):return lambda s:node(s,nid)['on']['click'][0].__setitem__(key,value)
for name,mutate,code in [
 ('row scope escape',set_text('status',{'item':'title'}),'E_ROW_SCOPE'),
 ('unknown row field',set_text('quantity',{'fn':'text','args':[{'item':'typo'}]}),'E_DATA_FIELD'),
 ('no implicit numeric text',set_text('quantity',{'item':'qty'}),'E_TYPE'),
 ('unknown runtime function',set_text('counter',{'fn':'eval','args':['code']}),'E_FUNCTION'),
 ('invalid function arity',set_text('counter',{'fn':'concat','args':['one']}),'E_ARGUMENT'),
 ('mixed arithmetic',set_action('increment','value',{'op':'+','left':{'variable':'count'},'right':'1'}),'E_TYPE'),
 ('division zero',set_action('increment','value',{'op':'/','left':1,'right':0}),'E_DIVISION_ZERO'),
 ('unknown operator',set_action('increment','value',{'op':'**','left':1,'right':2}),'E_OPERATOR'),
 ('immutable row identity',set_action('update','set',{'id':'other'}),'E_DATA_KEY'),
 ('unknown update column',set_action('update','set',{'wrong':1}),'E_PROPERTY'),
 ('predicate type',set_action('delete','where','anything'),'E_TYPE'),
 ('sort column',set_action('sort','column','wrong'),'E_DATA_FIELD'),
 ('pagination value',set_action('next','page',0),'E_PAGE'),
 ('data target type',set_action('delete','target',{'ref':'status'}),'E_TARGET_TYPE'),
 ('private row widget',set_text('status',{'widget':{'ref':'inventoryRuntime/items/item/title'}}),'E_ROW_SCOPE'),
 ('invalid page size',lambda s:node(s,'items').__setitem__('pageSize',-1),'E_SIZE'),
 ('repeater x requires number',lambda s:node(s,'items').__setitem__('x','fill'),'E_TYPE'),
 ('repeater change event',lambda s:node(s,'items').__setitem__('on',{'change':[{'type':'wait','ms':1}]}),'E_EVENT'),
 ('complete added row',lambda s:node(s,'add')['on']['click']['cases'][0]['actions'][0]['rows'][0].pop('title'),'E_FIELD_MISSING'),
 ('row input unsupported',lambda s:node(s,'items').__setitem__('template',{'type':'input','id':'field'}),'E_ROW_CONTAINER'),
 ('nested repeater unsupported',lambda s:node(s,'items').__setitem__('template',{'type':'repeater','id':'nested','dataset':'items','key':'id','template':{'type':'label','id':'title','text':'x'}}),'E_ROW_CONTAINER'),
 ('duplicate initial key',lambda s:s['datasets']['items']['rows'][1].__setitem__('id','1'),'E_DATA_KEY'),
]:reject(name,mutate,code)

for key in ('variable','fn','op'):reject('malformed '+key,set_text('counter',{key:[]}),'E_TYPE')

def cycle(s):
    node(s,'counter')['text']={'widget':{'ref':'status'}};node(s,'status')['text']={'widget':{'ref':'counter'}}
reject('binding cycle',cycle,'E_BINDING_CYCLE')

def cross_record(s):
    rep=copy.deepcopy(node(s,'items'))
    s['pages'][0]['root']['children']=[{'type':'dynamic-panel','id':'outer','w':800,'h':250,'states':[{'id':'editing','root':rep}]},{'type':'button','id':'outside','text':'delete','on':{'click':[{'type':'data-delete','target':{'ref':'inventoryRuntime/outer/editing/items'},'where':True}]}}]
reject('cross-record data action',cross_record,'E_DATA_SCOPE')


def values():
    source=fixture();lowered,ir=compile_language(source)
    counter=next(n for n in lowered['pages'][0]['root']['children'] if n.get('name','').startswith('txt-counter-'))
    assert counter['text']=='操作计数：0' and counter['w']=='fill'
    assert any(ix['trigger'].startswith('inp-newTitle-') for ix in lowered['pages'][0]['interactions'])
check('initial bound geometry and input refresh',values)

def conversions():
    for value, expected in [(12,'12'), ('12','12'), ('abc','0'), ('NaN','0'), ('0x10','16')]:
        source=fixture();node(source,'counter')['text']={'fn':'text','args':[{'fn':'number','args':[value]}]}
        lowered,_=compile_language(source)
        counter=next(n for n in lowered['pages'][0]['root']['children'] if n.get('name','').startswith('txt-counter-'))
        assert counter['text']==expected,(value,counter['text'])
check('initial number conversion accepts number and text',conversions)

def component_runtime():
    source=fixture()
    source['components']={'Caption':{'params':{'prefix':'text','step':'number'},'root':{
        'type':'label','id':'caption','text':{'fn':'concat','args':[{'$':'prefix'},
        {'fn':'text','args':[{'op':'+','left':{'variable':'count'},'right':{'$':'step'}}]}]}}}}
    source['pages'][0]['root']['children'].append({'type':'use','id':'captionInstance',
        'component':'Caption','args':{'prefix':'计数：','step':2}})
    lowered,ir=compile_language(source)
    symbol=next(s for s in ir['symbols'] if s['id'].endswith('/captionInstance/caption'))
    caption=next(n for n in lowered['pages'][0]['root']['children'] if n.get('name')==symbol['name'])
    assert caption['text']=='计数：2'
    assert '"$"' not in json.dumps(ir['pages'])
check('component parameters inside runtime calls and arithmetic',component_runtime)

def topology():
    source=fixture();node(source,'status')['text']={'widget':{'ref':'counter'}}
    lowered,_=compile_language(source)
    status=next(n for n in lowered['pages'][0]['root']['children'] if n.get('name','').startswith('txt-status-'))
    assert status['text']=='操作计数：0'
check('forward binding topology',topology)

def identity():
    source=fixture();full=compile_language(source)[1];source['datasets']['items']['rows']=[];empty=compile_language(source)[1]
    assert [s['id'] for s in full['symbols']]==[s['id'] for s in empty['symbols']]
check('empty data retains one stable row template',identity)

def metadata():
    source=fixture();before=compile_language(source)[1]['semanticHash'];source['$schema']='../../references/rp-language.schema.json'
    assert before==compile_language(source)[1]['semanticHash']
check('editor metadata has no semantic effect',metadata)
check('generated schema matches compiler vocabulary',lambda: (_ for _ in ()).throw(AssertionError()) if language_schema()!=json.loads((ROOT/'references/rp-language.schema.json').read_text()) else None)

cli=ROOT/'scripts/rp_language_cli.py'
p=subprocess.run([sys.executable,'-S',str(cli),'check','--spec',str(ROOT/'examples/rp-language/runtime-inventory.json')],capture_output=True,text=True)
check('check uses only standard library',lambda:json.loads(p.stdout)['ok'] if p.returncode==0 else (_ for _ in ()).throw(AssertionError(p.stderr)))
with tempfile.TemporaryDirectory() as temp:
    source=Path(temp)/'source.json'
    for label,text,code in [('syntax','{\n"language":,}','E_JSON_SYNTAX'),('duplicate','{"language":"rp/1","language":"rp/1"}','E_DUPLICATE_PROPERTY'),('nonfinite','{"value":NaN}','E_JSON_NUMBER')]:
        source.write_text(text)
        result=subprocess.run([sys.executable,str(cli),'check','--spec',str(source)],capture_output=True,text=True)
        issue=json.loads(result.stderr)['diagnostics'][0]
        assert result.returncode==1 and issue['code']==code
        if label=='syntax':assert issue['line']==2 and issue['column']>0
        checks+=1;print('PASS diagnostic',label)
    source.write_text(json.dumps(fixture()));out=Path(temp)/'formatted.json'
    args=[sys.executable,str(cli),'format','--spec',str(source),'--out',str(out)]
    result=subprocess.run(args,capture_output=True,text=True);assert result.returncode==0,result.stderr
    assert compile_language(json.loads(source.read_text()))[1]==compile_language(json.loads(out.read_text()))[1]
    assert subprocess.run(args,capture_output=True).returncode==1
    checks+=1;print('PASS formatter preserves meaning and refuses overwrite')
print(json.dumps({'ok':True,'checks':checks}))
