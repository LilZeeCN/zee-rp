#!/usr/bin/env python3
"""Validate benchmark JSON, result accounting and generated audit consistency."""
import argparse
import hashlib
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load(path):
    def invalid(value):
        raise ValueError('Non-JSON numeric constant: ' + value)
    return json.loads(path.read_text(), parse_constant=invalid)


def validate(value, schema, root=None, path='$'):
    """Small validator for the JSON Schema keywords used by this package."""
    root = root or schema
    if '$ref' in schema:
        target = root
        for key in schema['$ref'].removeprefix('#/').split('/'):
            target = target[key]
        validate(value, target, root, path)
        return
    if 'anyOf' in schema:
        for option in schema['anyOf']:
            try:
                validate(value, option, root, path)
                break
            except ValueError:
                pass
        else:
            raise ValueError(path + ': no anyOf option matched')
    if 'const' in schema and value != schema['const']:
        raise ValueError(path + ': const mismatch')
    if 'enum' in schema and value not in schema['enum']:
        raise ValueError(path + ': enum mismatch')
    types = schema.get('type', [])
    types = [types] if isinstance(types, str) else types
    matches = {'null': value is None, 'object': isinstance(value, dict),
               'array': isinstance(value, list), 'string': isinstance(value, str),
               'integer': type(value) is int, 'number': type(value) in (int, float),
               'boolean': type(value) is bool}
    if types and not any(matches[t] for t in types):
        raise ValueError(path + ': type mismatch')
    if isinstance(value, dict):
        for key in schema.get('required', []):
            if key not in value:
                raise ValueError(path + ': missing ' + key)
        props = schema.get('properties', {})
        if schema.get('additionalProperties') is False:
            extra = set(value) - set(props)
            if extra:
                raise ValueError(path + ': unknown keys ' + ','.join(sorted(extra)))
        for key in value.keys() & props.keys():
            validate(value[key], props[key], root, path + '.' + key)
    if isinstance(value, list):
        if len(value) < schema.get('minItems', 0):
            raise ValueError(path + ': too few items')
        for i, child in enumerate(value):
            validate(child, schema.get('items', {}), root, f'{path}[{i}]')
    if isinstance(value, str):
        if len(value) < schema.get('minLength', 0):
            raise ValueError(path + ': too short')
        if 'pattern' in schema and not re.search(schema['pattern'], value):
            raise ValueError(path + ': pattern mismatch')
    if type(value) in (int, float):
        if value < schema.get('minimum', float('-inf')) or value > schema.get('maximum', float('inf')):
            raise ValueError(path + ': numeric bounds')


def accounting(result, ledger=None):
    if result['tokens']['measurement'] == 'unavailable':
        if any(result['tokens'][key] is not None for key in ('input', 'output', 'total')):
            raise ValueError('Unavailable token usage must use null, not zero or byte estimates')
    elif not result['tokens']['sourceEvidenceIds']:
        raise ValueError('Provider token usage needs original evidence')
    experience = result['experience']
    if experience['classification'] == 'independent':
        if experience['readImplementation'] is not False or experience['priorSameTaskExposure'] is not False or experience['assistance']:
            raise ValueError('Independent requires no implementation/same-task exposure or assistance')
    ids = {a['id'] for a in result['artifacts']}
    if len(ids) != len(result['artifacts']):
        raise ValueError('Artifact IDs must be unique')
    for level, evidence in result['evidence'].items():
        if not set(evidence['evidenceIds']) <= ids:
            raise ValueError('Unknown evidence artifact: ' + level)
        if evidence['status'] == 'passed' and not evidence['evidenceIds']:
            raise ValueError('Passed layer needs original artifact: ' + level)
        if evidence['status'] == 'passed' and level in {'semantic', 'browser-pointer', 'axure-preview'}:
            if not evidence['assertionCount'] or evidence['assertionCount'] < 1:
                raise ValueError('Behavioral pass needs nonzero actual assertions: ' + level)
    for item in result['checks'] + result['ratings']:
        if not set(item['evidenceIds']) <= ids:
            raise ValueError('Unknown check/rating evidence')
    if result['outcome'] == 'completed':
        if any(result['documentBinding'][key] is None for key in ('documentId', 'revision', 'contentHash')):
            raise ValueError('Completed result needs document version binding')
        for key in ('sourceTreeSha256', 'briefSha256'):
            if result['fingerprint'][key] is None:
                raise ValueError('Completed result needs ' + key)
        execution = result.get('execution', {}).get('kind', 'model-agent')
        model_id = result['fingerprint']['model']['id']
        if execution == 'scripted-regression':
            if model_id is not None or any(item.get('source') in {'agent', 'user'} for item in result['ratings']):
                raise ValueError('Scripted regression has no actual model or AI usability rating')
        elif model_id is None or model_id == 'studio-task-runner-v1':
            raise ValueError('Completed AI result needs actual model ID, not a script runner name')
        if result['experience']['classification'] == 'unclassified':
            raise ValueError('Completed run must classify caller experience')
        if ledger is None:
            raise ValueError('Completed run needs its actual call ledger')
        # M-GAPS#2:按执行类型分要求。scripted-regression(脚本式基线)的产物面是
        # art-* 命名,从不产出真实模型回执面的 structure/actor-evidence/feedback 等
        # artifact id——那是 run-model-trials 回执链的产物;此前统一的 required_artifacts
        # 使脚本式基线自 1c900df 起无法通过验收。真实模型路径的语义一字不动。
        required_evidence = ('source-structure', 'semantic', 'browser-render', 'browser-pointer')
        if execution == 'scripted-regression':
            for level in required_evidence:
                evidence = result['evidence'][level]
                if evidence['status'] != 'passed':
                    raise ValueError(f'Completed scripted run needs passed {level} evidence')
                if not evidence['evidenceIds']:
                    raise ValueError(f'Passed layer needs original artifact: {level}')
        else:
            required_evidence = {
                'source-structure': 'structure',
                'semantic': 'semantic',
                'browser-render': 'render',
                'browser-pointer': 'pointer',
            }
            for level, artifact_id in required_evidence.items():
                evidence = result['evidence'][level]
                if evidence['status'] != 'passed' or artifact_id not in evidence['evidenceIds']:
                    raise ValueError(f'Completed run needs passed {level} evidence from {artifact_id}')
            required_artifacts = {
                'structure', 'semantic', 'render', 'pointer', 'actor-evidence',
                'fresh-reopen', 'observed-content', 'events', 'feedback',
            }
            actual_artifacts = {item['id'] for item in result['artifacts']}
            missing = sorted(required_artifacts - actual_artifacts)
            if missing:
                raise ValueError('Completed run missing evidence artifacts: ' + ','.join(missing))
        for artifact in result['artifacts']:
            if artifact['sha256'] is None:
                raise ValueError('Completed run artifact is not hashed: ' + artifact['id'])
            binding = artifact.get('binding') or {}
            if any(binding.get(key) != result['documentBinding'][key] for key in ('documentId', 'revision', 'contentHash')):
                raise ValueError('Artifact binding differs from final document: ' + artifact['id'])
    if ledger is None:
        return
    if len({row['callId'] for row in ledger}) != len(ledger):
        raise ValueError('Call IDs must be unique')
    rows = [row for row in ledger if row['eventKind'] == 'attempt']
    counts = {'total': len(rows), 'timedOut': sum(r['status'] == 'timeout' for r in rows),
              'uncertain': sum(r['status'] == 'uncertain' for r in rows),
              'discovery': sum(r['phase'] == 'discovery' for r in rows),
              'creation': sum(r['phase'] == 'creation' for r in rows)}
    for key, expected in counts.items():
        if result['calls'][key] != expected:
            raise ValueError(f'Ledger mismatch {key}: expected {expected}')
    first_mutation = next((r['callId'] for r in rows if r['authoredMutation']), None)
    if result['calls']['firstMutationCallId'] != first_mutation:
        raise ValueError('First mutation must match actual attempt ledger, including failed writes')
    creation_started = False
    for row in rows:
        if row['phase'] == 'creation':
            creation_started = True
        if creation_started and row['phase'] == 'discovery':
            raise ValueError('Discovery cannot restart after creation')
        if row['authoredMutation'] and row['phase'] != 'creation':
            raise ValueError('Authored mutation is a creation call')
    budget = result['budget']
    exceeded = counts['total'] > budget['maxToolCalls'] or counts['discovery'] > budget['maxDiscoveryCallsBeforeFirstWrite']
    elapsed = result['timestamps']['wallClockMs']
    exceeded = exceeded or (elapsed is not None and elapsed > budget['maxWallClockSeconds'] * 1000)
    if exceeded and result['outcome'] == 'completed':
        raise ValueError('Budget excess must remain a recorded failure/budget-exceeded, not completed')


def validate_suite(root):
    suite = load(HERE / 'tasks.json')
    tasks = suite['tasks']
    if len(tasks) != 8 or {t['id'] for t in tasks} != {f'T{i:02d}' for i in range(1, 9)}:
        raise ValueError('Expected exactly the eight fixed task IDs')
    scenarios, assertions = 0, 0
    for task in tasks:
        if not task['requiredContent'] or not task['requiredStates'] or not task['allowedScope']:
            raise ValueError('Incomplete brief: ' + task['id'])
        if task['budget']['maxDiscoveryCallsBeforeFirstWrite'] != 5 or not task['budget']['sameForComparedSystems']:
            raise ValueError('Discovery/comparison budget missing')
        for scenario in task['scenarios']:
            scenarios += 1
            if not scenario['steps']:
                raise ValueError('Empty scenario')
            count = 0
            for step in scenario['steps']:
                if step.get('action') not in {'click', 'input', 'expect'}:
                    raise ValueError('Use supported shared browser/semantic action subset')
                for key, value in step.get('expect', {}).items():
                    if key not in {'page', 'text', 'visible', 'variables'}:
                        raise ValueError('Unsupported shared assertion: ' + key)
                    if value in ({}, [], None):
                        raise ValueError('Empty assertion')
                    count += 1 if key == 'page' else len(value)
                if step.get('action') in {'click', 'input'} and not step.get('target'):
                    raise ValueError('Action missing target')
            if not count:
                raise ValueError('Zero-assertion scenario')
            assertions += count
    data = load(HERE / 'fixtures/records.json')
    rows, expected = data['records'], data['expected']
    if len(rows) != expected['totalCount'] or sum(r['amount'] for r in rows) != expected['sumAmount']:
        raise ValueError('Dataset totals do not match fixed expected results')
    pending = [r for r in rows if r['status'] == '待处理']
    if len(pending) != expected['pendingCount'] or [r['id'] for r in sorted(pending, key=lambda r: -r['amount'])] != expected['pendingDescendingIds']:
        raise ValueError('Filter/sort expected results drift')
    for asset in load(HERE / 'fixtures/assets.json')['assets']:
        path = root / asset['path']
        if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != asset['sha256']:
            raise ValueError('Fixed source asset missing or changed: ' + asset['path'])
    return {'taskCount': len(tasks), 'scenarioCount': scenarios, 'declaredAssertions': assertions,
            'status': 'definition-validated-not-product-executed'}


def audit_checks(path):
    inventory = load(path / 'inventory.json')
    commands = load(path / 'commands.json')['commands']
    fields = load(path / 'node-fields.json')['fields']
    matrix = load(path / 'coverage-matrix.json')
    graph = load(path / 'test-entrypoints.json')
    if len(commands) != inventory['commandCount'] or sum(c['detailedContract'] for c in commands) != inventory['detailedContractCount']:
        raise ValueError('Command/contract count mismatch')
    if len(fields) != inventory['nodePropertyCount']:
        raise ValueError('Property count mismatch')
    if any(c['status'] != 'not-measured' or c['evidenceIds'] for c in matrix['cells']):
        raise ValueError('Static audit cannot report executed coverage cells')
    if graph['summary']['actuallyExecutedThisAudit'] != 0:
        raise ValueError('Static dispatch graph must not claim runtime tests')
    return {'commandCount': len(commands), 'detailedContractCount': inventory['detailedContractCount'],
            'nodePropertyCount': len(fields), 'unmeasuredCrossProductCells': len(matrix['cells'])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=HERE.parents[1])
    parser.add_argument('--result', type=Path)
    parser.add_argument('--ledger', type=Path)
    parser.add_argument('--audit', type=Path, action='append', default=[])
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    checked = [str(p.relative_to(HERE)) for p in sorted(HERE.rglob('*.json'))]
    for path in HERE.rglob('*.json'):
        load(path)
    schema = load(HERE / 'result.schema.json')
    template = load(HERE / 'result-template.json')
    validate(template, schema)
    accounting(template)
    result = {'ok': True, 'suite': validate_suite(args.root), 'jsonFilesParsed': checked,
              'unexecutedTemplateValidated': True, 'audits': [audit_checks(p) for p in args.audit],
              'productTaskRuns': 0}
    if args.result:
        value = load(args.result)
        validate(value, schema)
        ledger = None
        if args.ledger:
            ledger = [json.loads(line) for line in args.ledger.read_text().splitlines() if line.strip()]
            ledger_schema = load(HERE / 'call-ledger.schema.json')
            for row in ledger:
                validate(row, ledger_schema)
            if value['calls']['ledgerPath'] != args.ledger.name:
                raise ValueError('Result ledgerPath must match the supplied call ledger')
            for artifact in value['artifacts']:
                if artifact['relativeTo'] == 'runDir':
                    artifact_path = (args.result.parent / artifact['path']).resolve()
                    if args.result.parent.resolve() not in artifact_path.parents:
                        raise ValueError('Artifact escapes its run directory: ' + artifact['id'])
                    if not artifact_path.is_file():
                        raise ValueError('Artifact is missing: ' + artifact['id'])
                    if hashlib.sha256(artifact_path.read_bytes()).hexdigest() != artifact['sha256']:
                        raise ValueError('Artifact hash mismatch: ' + artifact['id'])
        accounting(value, ledger)
        result['resultValidated'] = True
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
