"""Public language-tool entry points and compiler/editor source-shape parity."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from rp_language import compile_language, LanguageError
from rp_schema import language_schema
try:
    from jsonschema import Draft202012Validator
except ImportError:
    raise SystemExit('This editor-contract test requires the test-only jsonschema package; use a test virtual environment.')

CHECKS = 0
MATRIX = []

def check(label, fn):
    global CHECKS
    fn()
    CHECKS += 1
    print('PASS', label)

def fixture():
    return {'language': 'rp/1', 'variables': {'count': 0}, 'pages': [{'id': 'main', 'root': {
        'column': 'root', 'children': [
            {'label': 'title', 'text': 'Old title'},
            {'button': 'increment', 'text': 'Add', 'onClick': {'set': {'$count': '= $count + 1'}}},
        ]}}]}

def cli(*args, ok=True):
    p = subprocess.run(['node', str(ROOT / 'scripts/proto.mjs'), *map(str, args)], capture_output=True, text=True)
    raw = p.stdout if p.returncode == 0 else p.stderr
    try:
        result = json.loads(raw)
    except json.JSONDecodeError as error:
        raise AssertionError((args, p.returncode, p.stdout, p.stderr)) from error
    assert (p.returncode == 0) == ok, (args, result)
    if not ok:
        assert result['ok'] is False and result['diagnostics'][0]['code'].startswith('E_'), result
    return result

with tempfile.TemporaryDirectory() as td:
    temp = Path(td)
    source = temp / 'source.json'
    source.write_text(json.dumps(fixture()), encoding='utf-8')
    original = source.read_bytes()
    def discovery():
        p = subprocess.run(['node', str(ROOT / 'scripts/proto.mjs'), '--help'], capture_output=True, text=True)
        assert p.returncode == 0
        for name in ('inspect', 'explain', 'complete', 'explore', 'simulate', 'patch'):
            assert name in p.stdout, name
    check('official help discovers all delivered tools', discovery)
    check('official inspect', lambda: cli('inspect', '--spec', source)['symbols'])
    check('official explain target', lambda: cli('explain', '--spec', source, '--target', 'main/title')['symbol'])
    check('official local complete', lambda: cli('complete', '--spec', source, '--pointer', '/pages/0/root/children/0')['properties'])
    check('official bounded explore', lambda: cli('explore', '--spec', source, '--max-depth', '0', '--max-states', '2')['coverage'])
    steps = temp / 'steps.json'
    steps.write_text(json.dumps([{'target': 'main/increment'}]))
    check('simulate accepts a steps file and executes it', lambda: (lambda r: (_ for _ in ()).throw(AssertionError(r)) if r['final']['variables']['count'] != 1 else None)(cli('simulate', '--spec', source, '--steps', steps)))
    operations = temp / 'operations.json'
    operations.write_text(json.dumps([{'op': 'replace', 'path': '/pages/0/root/children/0/text', 'oldValue': 'Old title', 'value': 'New title'}]))
    patched = temp / 'patched.json'
    def patch():
        before = compile_language(fixture())[1]['semanticHash']
        result = cli('patch', '--spec', source, '--operations', operations, '--expected-hash', before, '--out', patched)
        assert result['diff']['beforeHash'] == before and result['diff']['afterHash'] != before
        assert json.loads(patched.read_text())['pages'][0]['root']['children'][0]['text'] == 'New title'
        assert source.read_bytes() == original
    check('guarded patch writes new source and reports its impact', patch)
    check('patch refuses existing output', lambda: cli('patch', '--spec', source, '--operations', operations, '--out', patched, ok=False))
    check('patch refuses stale expected hash', lambda: cli('patch', '--spec', source, '--operations', operations, '--expected-hash', 'stale', '--out', temp / 'stale.json', ok=False))
    for args in [
        ('inspect', '--spec', source, '--typo'),
        ('inspect', '--spec', source, '--max-depth', '2'),
        ('explain', '--spec', source),
        ('complete', '--spec', source, '--pointer', '/missing'),
        ('explore', '--spec', source, '--max-depth', '-1'),
        ('explore', '--spec', source, '--max-states', '0'),
        ('simulate', '--spec', source, '--steps'),
        ('patch', '--spec', source, '--operations', operations),
    ]:
        check('machine diagnostic ' + ' '.join(str(x) for x in args if x != source), lambda args=args: cli(*args, ok=False))
    for invalid in ({}, [None], [{'target': 'main/increment', 'rowIndex': -1}], [{'target': 'main/increment', 'event': []}], [{'target': 'main/increment', 'typo': 1}]):
        steps.write_text(json.dumps(invalid))
        check('invalid simulation steps ' + repr(invalid), lambda: cli('simulate', '--spec', source, '--steps', steps, ok=False))


def parity(label, source, valid):
    schema_valid = not list(Draft202012Validator(language_schema()).iter_errors(source))
    try:
        compile_language(source)
        compiler_valid = True
    except LanguageError:
        compiler_valid = False
    MATRIX.append({'name': label, 'expected': valid, 'schemaAccepted': schema_valid, 'compilerAccepted': compiler_valid, 'source': source})
    assert schema_valid == compiler_valid == valid, (label, schema_valid, compiler_valid)

check('full sugar spec accepted by editor and compiler', lambda: parity('sugar', fixture(), True))

def program(root, **extra):
    return {'language': 'rp/1', **extra, 'pages': [{'id': 'main', 'root': root}]}

data = {'datasets': {'books': [{'id': '1', 'title': "Children's", 'category': 'CS'}]}}
valid_programs = {
    'standard AST': {'language': 'rp/1', 'pages': [{'id': 'main', 'name': 'Main', 'canvas': {'w': 375, 'h': 812}, 'root': {'type': 'label', 'id': 'title', 'text': 'Hello'}}]},
    'array canvas and scalar variables': program({'label': 'title', 'text': '${$greeting}'}, variables={'greeting': 'Hello'}),
    'font and size sugar': program({'label': 'title', 'text': 'Hello', 'font': '14/600 $ink left', 'size': [100, 24]}),
    'numeric font size and weight': program({'label': 'title', 'text': 'Hello', 'size': 18, 'weight': 600, 'italic': True, 'underline': False, 'letterSpacing': 1}),
    'modern layout alignment': program({'row': 'root', 'wrap': True, 'justify': 'space-between', 'children': [{'button': 'go', 'variant': 'glass', 'text': 'Go'}]}),
    'relative stack geometry': program({'stack': 'root', 'w': 200, 'h': 100, 'children': [{'label': 'title', 'text': 'Hello', 'right': -2, 'bottom': 4, 'anchor': 'bottom-right'}]}),
    'modern visual values': program({'box': 'surface', 'w': 200, 'h': 100, 'opacity': 0.8, 'backdropBlur': 8, 'aurora': True, 'noise': 0.02, 'innerGlow': 0.2, 'borderSides': ['bottom'], 'children': []}),
    'rich text source': program({'label': 'title', 'text': 'Hello', 'spans': [{'text': 'Hello', 'color': '#334455'}]}),
    'sparkline numeric points': program({'sparkline': 'trend', 'points': [1, 4, 2], 'smooth': True, 'strokeWidth': 2, 'w': 200, 'h': 60}),
    'page load single action': {'language': 'rp/1', 'variables': {'count': 0}, 'pages': [{'id': 'main', 'canvas': [375, 812], 'root': {'label': 'title', 'text': 'Hello'}, 'onLoad': {'set': {'$count': 1}}}]},
    'conditional do sugar': program({'button': 'go', 'text': 'Go', 'onClick': {'cases': [{'when': True, 'do': {'set-variable': 'count', 'value': 1}}, {'else': True, 'actions': [{'set-variable': 'count', 'value': 2}]}]}}, variables={'count': 0}),
    'form-card': program({'form-card': 'edit', 'title': 'Edit', 'fields': [{'id': 'name', 'label': 'Name', 'h': 40}], 'onSubmit': {'set': {'@name': 'Done'}}}),
    'macro load event': program({'form-card': 'edit', 'fields': [{'id': 'name'}], 'onLoad': {'set': {'$count': 1}}}, variables={'count': 0}),
    'kv-list': program({'type': 'kv-list', 'id': 'detail', 'items': [{'label': 'Title', 'value': 'Compiler'}]}),
    'searchable-list': program({'searchable-list': 'booksView', 'dataset': 'books', 'searchField': 'title', 'filterField': 'category', 'filters': [{'label': 'All', 'all': True}, {'label': 'CS', 'value': 'CS'}], 'template': {'label': 'title', 'text': '${row.title}'}}, **data),
    'searchable-list empty filters': program({'searchable-list': 'booksView', 'dataset': 'books', 'searchField': 'title', 'filters': [], 'template': {'label': 'title', 'text': '${row.title}'}}, **data),
    'literal filter punctuation': program({'searchable-list': 'booksView', 'dataset': 'books', 'searchField': 'title', 'filters': [{'value': 'Children\'s "中文" \\'}], 'template': {'label': 'title', 'text': '${row.title}'}}, **data),
    'fractional kv-list geometry': program({'kv-list': 'detail', 'rowHeight': 24.5, 'items': [{'value': 'x'}]}),
    'data-table': program({'type': 'data-table', 'id': 'booksView', 'dataset': 'books', 'columns': [{'header': 'Title', 'field': 'title', 'w': 200}]}, **data),
    'repeater defaults and rows object inference': program({'repeater': 'booksView', 'dataset': 'books', 'template': {'label': 'title', 'text': '${row.title}'}}, datasets={'books': {'rows': data['datasets']['books']}}),
    'compile repeat defaults': program({'repeat': 'booksView', 'dataset': 'books', 'template': {'label': 'title', 'text': '${item.title}'}}, **data),
    'component inline arguments': program({'use': 'Card', 'id': 'card', 'caption': 'Hello'}, components={'Card': {'params': {'caption': 'text'}, 'root': {'label': 'caption', 'text': {'$': 'caption'}}}}),
    'explicit component arguments': program({'type': 'use', 'id': 'card', 'component': 'Card', 'args': {'caption': 'Hello'}}, components={'Card': {'params': {'caption': 'text'}, 'root': {'label': 'caption', 'text': {'$': 'caption'}}}}),
    'component enum and numeric expressions': program({'use': 'Card', 'id': 'card', 'align': 'right', 'size': 16}, components={'Card': {'params': {'align': 'text', 'size': 'number'}, 'root': {'label': 'caption', 'text': 'Hello', 'align': {'$': 'align'}, 'fontSize': {'expr': 'param.size + 1'}}}}),
}
for name, source in valid_programs.items():
    check('schema/compiler valid matrix ' + name, lambda name=name, source=source: parity(name, source, True))

for kind in ('row', 'column', 'grid', 'stack'):
    check('layout alias ' + kind, lambda kind=kind: parity(kind, program({'type': kind, 'id': 'root', 'children': []}), True))

for event_value in ({'show': 'title'}, [{'hide': 'title'}, {'show': 'title'}], {'cases': [{'actions': {'toggle': 'title'}}]}):
    source = program({'column': 'root', 'children': [{'label': 'title', 'text': 'Hello'}, {'button': 'go', 'on': {'click': event_value}}]})
    check('event source shape ' + repr(event_value), lambda source=source: parity('event source shape', source, True))

for action in ({'state': ['panel', 'ready']}, {'set-state': 'panel.ready'}, {'set': {'panel.state': 'ready'}}, {'type': 'show', 'target': 'panel'}):
    source = program({'column': 'root', 'children': [{'dynamic-panel': 'panel', 'states': [{'id': 'ready', 'root': {'label': 'title', 'text': 'Ready'}}]}, {'button': 'go', 'onClick': action}]})
    check('panel action sugar ' + repr(action), lambda source=source: parity('panel action sugar', source, True))

source = program({'column': 'root', 'children': [{'repeater': 'booksView', 'dataset': 'books', 'template': {'label': 'title', 'text': '${row.title}'}}, {'button': 'add', 'onClick': {'type': 'data-add', 'target': 'booksView', 'row': {'id': '2', 'title': 'New', 'category': 'CS'}}}]}, **data)
check('data action row shorthand', lambda: parity('data-add row', source, True))

invalid_programs = {
    'unknown root property': {**fixture(), 'typo': 1},
    'unknown standard node property': program({'type': 'label', 'id': 'title', 'text': 'Hi', 'typo': 1}),
    'unknown sugar node property': program({'button': 'go', 'typo': 1}),
    'unknown macro property': program({'kv-list': 'detail', 'items': [{'value': 'x'}], 'rowHieght': 24}),
    'unknown column property': program({'data-table': 'booksView', 'dataset': 'books', 'columns': [{'field': 'title', 'typo': 1}]}, **data),
    'unknown field property': program({'form-card': 'edit', 'fields': [{'id': 'name', 'typo': 1}]}),
    'unknown filter property': program({'searchable-list': 'booksView', 'dataset': 'books', 'searchField': 'title', 'template': {'label': 'title', 'text': '${row.title}'}, 'filters': [{'value': 'CS', 'typo': 1}]}, **data),
    'wrong form height': program({'form-card': 'edit', 'fields': [{'id': 'name', 'h': 'hug'}]}),
    'wrong macro row height': program({'kv-list': 'detail', 'rowHeight': '24', 'items': [{'value': 'x'}]}),
    'unknown action field': program({'button': 'go', 'onClick': {'show': 'go', 'typo': 1}}),
    'empty action set': program({'button': 'go', 'onClick': {'set': {}}}),
    'malformed state tuple': program({'button': 'go', 'onClick': {'state': ['panel']}}),
    'malformed runtime object': program({'label': 'title', 'text': {'fn': 'concat', 'args': ['a', 'b'], 'typo': 1}}),
    'empty inferred dataset': program({'label': 'title'}, datasets={'books': []}),
    'unknown dataset field': program({'label': 'title'}, datasets={'books': {'rows': data['datasets']['books'], 'typo': 1}}),
    'empty macro fields': program({'form-card': 'edit', 'fields': []}),
    'invalid padding length': program({'column': 'root', 'padding': [1, 2, 3]}),
    'negative font size': program({'label': 'title', 'fontSize': -1}),
}
for name, source in invalid_programs.items():
    check('schema/compiler invalid matrix ' + name, lambda name=name, source=source: parity(name, source, False))

def semantic_boundary():
    source = program({'button': 'go', 'onClick': {'show': 'missing'}})
    assert not list(Draft202012Validator(language_schema()).iter_errors(source))
    try:
        compile_language(source)
    except LanguageError as error:
        assert error.diagnostic['code'] == 'E_REFERENCE'
    else:
        raise AssertionError('Missing reference was accepted')
check('schema leaves cross-object reference validation to check', semantic_boundary)

for path in sorted((ROOT / 'examples/rp-language').glob('*.json')):
    check('editor accepts standard fixture ' + path.name, lambda path=path: parity(path.name, json.loads(path.read_text()), True))

Draft202012Validator.check_schema(language_schema())
check('generated schema file exactly matches generator', lambda: (_ for _ in ()).throw(AssertionError()) if language_schema() != json.loads((ROOT / 'references/rp-language.schema.json').read_text()) else None)
if '--evidence' in sys.argv:
    Path(sys.argv[sys.argv.index('--evidence') + 1]).write_text(json.dumps(MATRIX, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'ok': True, 'checks': CHECKS}))
