"""Data/action regressions with independent arithmetic and a fixed random seed.

Native HTML acceptance lives in research-rp/rp1-reliability-20261020;
this reference-model test does not replace that browser evidence.
"""
import copy
import json
from pathlib import Path
import random
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from rp_language import compile_language, LanguageError, ReferenceRuntime

source = json.loads((ROOT / 'test/fixtures/rp-aggregate-matrix.json').read_text())
cases = json.loads((ROOT / 'test/fixtures/rp-aggregate-cases.json').read_text())
compiled = compile_language(source)
checks = 0

def verify(rt, expected, name):
    global checks
    actual = {key: rt.variables[key] for key in expected}
    assert actual == expected, (name, expected, actual)
    repeater = rt.resolve_trigger_name('matrix/items')
    rows = rt.repeaters[repeater]['rows']
    assert len(rows) == rt.variables['ds_count'], (name, 'row loss', rows)
    assert sum(row['price'] * row['qty'] for row in rows) == rt.variables['ds_sum'], (name, 'dataset arithmetic', rows)
    checks += 1

for case in cases:
    rt = ReferenceRuntime(compiled)
    for step in case['steps']:
        rt.trigger('matrix/' + step)
    verify(rt, case['expected'], case['name'])

rng = random.Random(20261020)
for trajectory in range(32):
    rt = ReferenceRuntime(compiled)
    rows = [{'id': 'A', 'price': 10, 'qty': 1}, {'id': 'B', 'price': 3, 'qty': 2}, {'id': 'C', 'price': 7, 'qty': 3}]
    category, ordered, page, factor, threshold = None, False, 1, 1, 7
    for index in range(10):
        choices = ['only_b', 'expensive', 'no_match', 'clear', 'inc_all', 'delete_b', 'delete_all', 'sort', 'unsort', 'next', 'last', 'first', 'factor', 'threshold', 'swap', 'combo']
        if not any(row['id'] == 'D' for row in rows): choices.append('add')
        step = rng.choice(choices)
        if step in ('only_b', 'expensive', 'no_match', 'clear'):
            category = {'only_b': 'B', 'expensive': 'price', 'no_match': 'none', 'clear': None}[step]
            page = 1
        elif step == 'inc_all':
            for row in rows: row['qty'] += 1
        elif step == 'delete_b': rows = [row for row in rows if row['id'] != 'B']
        elif step == 'delete_all': rows = []
        elif step == 'add': rows.append({'id': 'D', 'price': 5, 'qty': 4})
        elif step == 'sort': ordered = True
        elif step == 'unsort': ordered = False
        elif step == 'next': page += 1
        elif step == 'last': page = 10**9
        elif step == 'first': page = 1
        elif step == 'factor': factor = 2
        elif step == 'threshold': threshold = 99
        elif step == 'swap':
            for row in rows:
                if row['id'] == 'A':
                    row['qty'] = row['price']
                    row['price'] = row['qty']
        elif step == 'combo':
            for row in rows:
                if row['id'] == 'B': row['qty'] += 1
            rows = [row for row in rows if row['id'] != 'C']
        active = [row for row in rows if category is None or category == 'B' and row['id'] == 'B' or category == 'price' and row['price'] >= 7]
        if category == 'none': active = []
        if ordered: active = sorted(active, key=lambda row: row['price'])
        page = min(max(1, page), max(1, (len(active) + 1) // 2))
        visible = active[(page - 1) * 2:page * 2]
        total = sum(row['price'] * row['qty'] for row in rows)
        expected = {'ds_sum': total, 'ds_count': len(rows), 'vs_sum': sum(row['price'] * row['qty'] for row in visible), 'vs_count': len(visible),
            'high_sum': sum(row['price'] * row['qty'] for row in rows if row['price'] >= threshold), 'weighted': total * factor, 'formula': total * factor}
        rt.trigger('matrix/' + step)
        verify(rt, expected, f'seed-20261020/{trajectory}/{index}')

rt = ReferenceRuntime(compiled)
rt.trigger('matrix/inc_all')
rt.trigger('matrix/away')
rt.trigger('other/back')
verify(rt, cases[0]['expected'], 'page re-entry resets datasets and aggregates')

# Reversed declaration order, formula-to-aggregate and aggregate-to-formula
# chains must use complete upstream values rather than partial row sums.
rt = ReferenceRuntime(compiled)
verify(rt, {'chain': 222, 'formula_weight': 12, 'raw_formula': 2, 'input_weight': 12, 'input_visible': 6}, 'computed chain initialization')
rt.trigger('matrix/factor')
verify(rt, {'chain': 444, 'formula_weight': 24, 'raw_formula': 4, 'input_weight': 12, 'input_visible': 6}, 'computed chain scalar change')
rt.trigger('matrix/inc_all')
verify(rt, {'chain': 1026, 'formula_weight': 36, 'raw_formula': 4, 'input_weight': 18, 'input_visible': 10}, 'computed chain row update')
rt.set_input('matrix/scale', '3')
verify(rt, {'chain': 1026, 'formula_weight': 36, 'raw_formula': 4, 'input_weight': 27, 'input_visible': 15}, 'input dependency')
rt.trigger('matrix/away'); rt.trigger('other/back')
verify(rt, {'chain': 444, 'formula_weight': 24, 'raw_formula': 4, 'input_weight': 12, 'input_visible': 6}, 'page re-entry uses live variables and fresh input defaults')

spec = copy.deepcopy(source)
spec['computed']['chain']['compute']['field'] = '=item.qty * var.vs_sum'
try:
    compile_language(spec)
except LanguageError as error:
    assert error.diagnostic['code'] == 'E_COMPUTED_DEPENDENCY', error.diagnostic
else:
    raise AssertionError('Accepted asynchronous visible-to-aggregate dependency')
checks += 1

panel_source = json.loads((ROOT / 'test/fixtures/rp-aggregate-panel.json').read_text())
rt = ReferenceRuntime(compile_language(panel_source))
for step, expected in [(None, (2, 2, 1, 1)), ('panelData/outer/editing/addLeft', (5, 2, 2, 1)), ('panelData/outer/editing/addRight', (5, 5, 2, 2)), ('panelData/outer/editing/leave', (5, 5, 2, 2)), ('panelData/outer/summary/back', (5, 5, 2, 2))]:
    if step: rt.trigger(step)
    assert tuple(rt.variables[key] for key in ('left_sum', 'right_sum', 'left_count', 'right_count')) == expected, (step, rt.variables)
    checks += 1

startup_source = json.loads((ROOT / 'test/fixtures/rp-aggregate-startup.json').read_text())
startup_compiled = compile_language(startup_source)
rt = ReferenceRuntime(startup_compiled)
for name, expected in [
    ('startup filter and update', {'ds_sum': 57, 'vs_sum': 9, 'vs_count': 1, 'raw_formula': 4, 'formula_weight': 36, 'input_visible': 6}),
    ('startup input dependency', {'raw_formula': 6, 'formula_weight': 54, 'input_weight': 27, 'input_visible': 9}),
    ('startup page re-entry', {'ds_sum': 57, 'vs_sum': 9, 'vs_count': 1, 'raw_formula': 4, 'formula_weight': 36, 'input_visible': 6}),
]:
    assert {key: rt.variables[key] for key in expected} == expected, (name, rt.variables)
    checks += 1
    if name == 'startup filter and update': rt.set_input('matrix/scale', '3')
    elif name == 'startup input dependency': rt.trigger('matrix/away'); rt.trigger('other/back')

for name in ('self', 'mutual', 'formula'):
    spec = copy.deepcopy(source)
    spec['computed']['ds_sum']['compute']['field'] = '=var.ds_sum * item.qty' if name == 'self' else '=var.weighted * item.qty'
    if name == 'mutual': spec['computed']['weighted']['compute']['field'] = '=var.ds_sum * item.qty'
    if name == 'formula': spec['computed']['weighted'] = {'type': 'number', 'compute': '=var.ds_sum * 2'}
    try:
        compile_language(spec)
    except LanguageError as error:
        assert error.diagnostic['code'] == 'E_BINDING_CYCLE', error.diagnostic
    else:
        raise AssertionError('Accepted cyclic aggregate: ' + name)
    checks += 1

print(json.dumps({'ok': True, 'checks': checks, 'seed': 20261020, 'randomTrajectories': 32, 'randomSteps': 320}))
