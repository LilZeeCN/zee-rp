#!/usr/bin/env python3
"""Prepare replayable reference traces and native Axure acceptance bundles."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys

from rp_language import ReferenceRuntime, compile_language
from rp_language_cli import read_source

SCRIPTS = Path(__file__).resolve().parent


def trace(source, plan):
    spec = read_source(str(source))
    compiled = compile_language(spec)
    ids = {s['id']: s for s in compiled[1]['symbols']}
    observe = plan['observe']
    if not any(observe.values()):
        raise ValueError('At least one observation is required')
    allowed = {'widgets', 'variables', 'repeaters', 'panels'}
    if observe.keys() - allowed:
        raise ValueError('Unknown observations: ' + str(observe.keys() - allowed))
    for kind in ('widgets', 'repeaters', 'panels'):
        for ident in observe.get(kind, []):
            if ident not in ids:
                raise ValueError('Unknown logical ID: ' + ident)
            if kind == 'repeaters' and ids[ident]['kind'] != 'repeater':
                raise ValueError('Not a repeater: ' + ident)
            if kind == 'panels' and ids[ident]['kind'] != 'dynamic-panel':
                raise ValueError('Not a panel: ' + ident)
    for name in observe.get('variables', []):
        if name not in compiled[1]['variables']:
            raise ValueError('Unknown variable: ' + name)

    def snapshot(rt):
        page = rt.current_page
        snap = {'page': page, 'widgets': {}, 'variables': {}, 'repeaters': {}, 'panels': {}}
        for ident in observe.get('widgets', []):
            sym = ids[ident]
            if sym['pageId'] == page:
                if rt.widgets[sym['name']].get('repeater'):
                    raise ValueError('Observe repeater data, not a single row template widget: ' + ident)
                snap['widgets'][ident] = rt.widgets[sym['name']]['text']
        for name in observe.get('variables', []):
            snap['variables'][name] = copy.deepcopy(rt.variables[name])
        for ident in observe.get('repeaters', []):
            sym = ids[ident]
            if sym['pageId'] == page:
                r = rt.repeaters[sym['name']]
                visible = rt.visible_rows(sym['name'])
                snap['repeaters'][ident] = {'rows': copy.deepcopy(r['rows']), 'visible': copy.deepcopy(visible), 'page': r['page_num']}
        for ident in observe.get('panels', []):
            sym = ids[ident]
            if sym['pageId'] == page:
                snap['panels'][ident] = rt.panels[sym['name']]['current']
        return snap

    scenarios = []
    if not plan.get('scenarios') or len({s['id'] for s in plan['scenarios']}) != len(plan['scenarios']):
        raise ValueError('Nonempty scenarios with unique IDs required')
    for scenario in plan['scenarios']:
        for section, values in scenario.get('assert', {}).items():
            if section not in allowed or not isinstance(values, dict) or set(values) - set(observe.get(section, [])):
                raise ValueError('Business assertions must reference observed values: ' + section)
        rt = ReferenceRuntime(compiled)
        states = [snapshot(rt)]
        for step in scenario['steps']:
            if not isinstance(step, dict) or set(step) - {'click', 'input', 'value', 'rowIndex'} or ('click' in step) == ('input' in step):
                raise ValueError('Step must contain exactly one click or input')
            target = step.get('click', step.get('input'))
            if target not in ids:
                raise ValueError('Unknown action target: ' + str(target))
            if 'rowIndex' in step and (type(step['rowIndex']) is not int or step['rowIndex'] < 0):
                raise ValueError('rowIndex must be a nonnegative integer')
            if 'input' in step:
                rt.set_input(target, step['value'])
            else:
                rt.trigger(target, row_index=step.get('rowIndex', 0))
            states.append(snapshot(rt))
        scenarios.append({**scenario, 'states': states})
    initial = ReferenceRuntime(compiled)
    return {'version': 1, 'source': str(Path(source).resolve()), 'sourceHash': hashlib.sha256(Path(source).read_bytes()).hexdigest(),
            'sourceText': Path(source).read_text(),
            'compilerHashes': {name: hashlib.sha256((SCRIPTS / name).read_bytes()).hexdigest() for name in ('rp_language.py', 'rp_schema.py', 'rp_product.py', 'rp_dsl.py', 'proto.py', 'proto.mjs', 'clone-library-widget.mjs')},
            'observe': observe, 'symbols': list(ids.values()), 'pages': [{'id': p['slug'], 'name': p['name']} for p in compiled[1]['pages']],
            'repeaterModels': {s['id']: initial.repeaters[s['name']]['model'] for s in ids.values() if s['kind'] == 'repeater'},
            'variableTypes': {k: v['type'] for k, v in compiled[1]['variables'].items()}, 'scenarios': scenarios}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    subs = p.add_subparsers(dest='command', required=True)
    for command in ('trace', 'prepare'):
        s = subs.add_parser(command)
        s.add_argument('--source', type=Path, required=True)
        s.add_argument('--plan', required=True, help='JSON file or - for stdin')
        if command == 'prepare':
            s.add_argument('--out', type=Path, required=True)
    s = subs.add_parser('browser-script')
    s.add_argument('--oracle', type=Path, required=True)
    s.add_argument('--url', required=True)
    s.add_argument('--space-id', type=int, required=True)
    s.add_argument('--run-dir', type=Path, required=True)
    s.add_argument('--out', type=Path, required=True)
    s.add_argument('--minimize', action='store_true')
    args = p.parse_args()
    if args.command == 'browser-script':
        # No OS automation: caller obtains the actual Preview URL in Axure first.
        from urllib.parse import urlparse
        url = urlparse(args.url)
        if url.hostname not in ('127.0.0.1', 'localhost') or url.scheme != 'http':
            p.error('Use an observed local Axure Preview URL')
        code = ('const {runNativeAcceptance}=await import(' + json.dumps((SCRIPTS / 'native-acceptance.mjs').as_uri()) + ');\n'
                + f'const task=await taskSpace({args.space_id});\n'
                + 'await runNativeAcceptance(task.page("p1"),' + json.dumps(str(args.oracle.resolve())) + ','
                + json.dumps(str(args.run_dir.resolve())) + ',' + json.dumps(args.url) + ',' + json.dumps({'minimize': args.minimize}) + ');\n')
        with args.out.open('x') as f:
            f.write(code)
        print(args.out)
        return
    plan = json.load(sys.stdin) if args.plan == '-' else json.loads(Path(args.plan).read_text())
    result = trace(args.source, plan)
    if args.command == 'trace':
        print(json.dumps(result, ensure_ascii=False))
        return
    args.out.mkdir(parents=True, exist_ok=False)
    (args.out / 'plan.json').write_text(json.dumps(plan, ensure_ascii=False, indent=2))
    (args.out / 'oracle.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    build = subprocess.run(['node', str(SCRIPTS / 'proto.mjs'), 'generate', '--spec', str(args.source.resolve()), '--out-dir', str(args.out.resolve() / 'bundle'), '--out-rp', str(args.out.resolve() / 'prototype.rp')], text=True, capture_output=True)
    (args.out / 'build.json').write_text(build.stdout)
    (args.out / 'build.stderr').write_text(build.stderr)
    if build.returncode:
        raise RuntimeError('Generation failed; inspect ' + str(args.out / 'build.stderr'))
    print(json.dumps({'oracle': str(args.out.resolve() / 'oracle.json'), 'prototype': str(args.out.resolve() / 'prototype.rp'), 'scenarios': len(result['scenarios'])}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
