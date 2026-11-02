#!/usr/bin/env python3
"""Read-only C01/Q01 inventory. Static references are never runtime coverage."""
import argparse
import datetime as dt
import hashlib
import itertools
import json
import re
import shutil
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_ROOT = HERE.parents[1]
PATTERNS = ('studio/*.mjs', 'studio/web/*.js', 'studio/web/*.html',
            'test/*.mjs', 'test/*.py', '.github/workflows/*.yml',
            '.github/workflows/*.yaml', 'references/rp-language.schema.json',
            'scripts/mcp-tools.mjs', 'bin/axure.mjs', 'bin/mcp.mjs', 'package.json')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def sources(root):
    paths = sorted({p for pattern in PATTERNS for p in root.glob(pattern) if p.is_file()})
    return {p.relative_to(root).as_posix(): p.read_text() for p in paths}


def fingerprint(files):
    entries = [{'path': p, 'sha256': digest(s.encode()), 'bytes': len(s.encode())}
               for p, s in sorted(files.items())]
    return {'algorithm': 'sha256', 'files': entries,
            'treeSha256': digest(json.dumps(entries, sort_keys=True, separators=(',', ':')).encode())}


def locations(files, pattern, paths=None, limit=30):
    rx = re.compile(pattern)
    hits = []
    for path in sorted(files if paths is None else paths):
        for line, text in enumerate(files.get(path, '').splitlines(), 1):
            if rx.search(text):
                hits.append({'path': path, 'line': line, 'excerpt': text.strip()[:240]})
    return {'total': len(hits), 'locations': hits[:limit], 'truncated': len(hits) > limit,
            'evidenceKind': 'static-reference-only'}


def command_groups(text):
    block = re.search(r'export const COMMAND_TYPES_BY_GROUP\s*=\s*\{(.*?)\n\};', text, re.S)
    if not block:
        raise ValueError('Cannot locate literal COMMAND_TYPES_BY_GROUP; update parser explicitly')
    groups = {}
    for match in re.finditer(r'([^\n:,{}]+):\s*\[([^\]]*)\]', block.group(1)):
        names = re.findall(r"['\"]([^'\"]+)['\"]", match.group(2))
        groups[match.group(1).strip().strip('\'\"')] = names
    if not groups or len({n for ns in groups.values() for n in ns}) != sum(map(len, groups.values())):
        raise ValueError('Empty or duplicated command declaration')
    return groups


def contracts(root):
    # This module is the actual authored schema, not a second handwritten DSL.
    js = "import {pathToFileURL} from 'node:url'; const m=await import(pathToFileURL(process.argv[1])); console.log(JSON.stringify(m.COMMAND_CONTRACTS));"
    result = subprocess.run(['node', '--input-type=module', '-e', js,
                             str(root / 'studio/command-contracts.mjs')],
                            check=True, capture_output=True, text=True, timeout=30)
    return json.loads(result.stdout)


def handler_blocks(text):
    cases = list(re.finditer(r"^    case ['\"]([^'\"]+)['\"]\s*:", text, re.M))
    result = {}
    for i, match in enumerate(cases):
        j = i
        while j + 1 < len(cases) and not text[cases[j].end():cases[j + 1].start()].strip():
            j += 1
        end = cases[j + 1].start() if j + 1 < len(cases) else text.find('\n    default:', cases[j].end())
        if end < 0:
            end = len(text)
        result[match.group(1)] = (text[match.end():end], text[:match.end()].count('\n') + 1)
    return result


def command_inventory(files, detailed):
    text = files['studio/commands.mjs']
    groups = command_groups(text)
    blocks = handler_blocks(text)
    command_names = [n for names in groups.values() for n in names]
    records = []
    fields = []
    for group, names in groups.items():
        for name in names:
            block, first_line = blocks.get(name, ('', 0))
            reads = set(re.findall(r'\bcmd\.([A-Za-z_$][\w$]*)', block)) | {'type', 'pageId'}
            reads.update(re.findall(r"\bcmd\[['\"]([^'\"]+)['\"]\]", block))
            # Literal keys used by cmd[k] loops are candidates, never executed proof.
            if re.search(r'\bcmd\[[a-zA-Z_$]', block):
                for literal in re.findall(r'\[([^\[\]]*)\]', block, re.S):
                    reads.update(re.findall(r"['\"]([\w.-]+)['\"]", literal))
            schema = detailed.get(name)
            declared = set(schema.get('properties', {})) if schema else set()
            for field in sorted(declared | reads):
                rx = re.compile(r'\bcmd\.' + re.escape(field) + r'\b|[\'\"]' + re.escape(field) + r'[\'\"]')
                hits = [{'path': 'studio/commands.mjs', 'line': first_line + i,
                         'excerpt': line.strip()[:240]}
                        for i, line in enumerate(block.splitlines()) if rx.search(line)]
                if field in {'type', 'pageId'}:
                    hits += locations(files, r'\bcmd\.' + field + r'\b', ['studio/commands.mjs'], 4)['locations']
                fields.append({'command': name, 'field': field, 'declared': field in declared,
                               'required': field in (schema or {}).get('required', []),
                               'schema': (schema or {}).get('properties', {}).get(field),
                               'handlerReadCandidate': field in reads,
                               'locations': hits[:15],
                               'status': 'static-read-candidate' if field in reads else 'delegation-or-consumption-unresolved',
                               'runtimeCoverage': 'not-measured'})
            ui = locations(files, r"\btype\s*:\s*['\"]" + re.escape(name) + r"['\"]", ['studio/web/app.js'])
            tests = locations(files, r"['\"]" + re.escape(name) + r"['\"]", [p for p in files if p.startswith('test/')])
            records.append({'command': name, 'group': group, 'detailedContract': schema is not None,
                            'contractSchema': schema, 'handlerFound': name in blocks,
                            'handlerStart': {'path': 'studio/commands.mjs', 'line': first_line},
                            'readFieldsCandidate': sorted(reads),
                            'declaredFieldsWithoutDirectRead': sorted(declared - reads),
                            'handlerFieldsWithoutDetailedDeclaration': sorted(reads - declared),
                            'entrypoints': {
                                'mcp': {'status': 'static-generic-route', 'tool': 'studio_apply_commands',
                                        'evidence': locations(files, r'studio_apply_commands|VALID_COMMAND_TYPES|/api/commands', ['studio/mcp-adapter.mjs'], 8)},
                                'cli': {'status': 'static-generic-route' if 'studio_apply_commands' in files.get('studio/cli.mjs', '') else 'not-exposed-by-studio-cli',
                                        'evidence': locations(files, r'studio_apply_commands|apply', ['studio/cli.mjs'], 8) if 'studio_apply_commands' in files.get('studio/cli.mjs', '') else 'studio/cli.mjs has no generic apply command; separate RP CLI is not Studio command coverage'},
                                'ui': {'status': 'static-literal-found' if ui['total'] else 'no-direct-literal-found', 'evidence': ui}},
                            'testReferences': tests, 'runtimeCoverage': 'not-measured'})
    return groups, records, fields, sorted(set(blocks) - set(command_names))


def node_fields(files):
    schema = json.loads(files['references/rp-language.schema.json'])
    names = {key for shape in schema['$defs']['node']['anyOf'] for key in shape.get('properties', {})}
    match = re.search(r'const studioFields\s*=\s*\[(.*?)\];', files['studio/node-properties.mjs'], re.S)
    if not match:
        raise ValueError('Cannot locate studioFields')
    names.update(re.findall(r"['\"]([^'\"]+)['\"]", match.group(1)))
    product = [p for p in files if p.startswith('studio/') and p != 'studio/node-properties.mjs']
    return [{'field': field, 'validation': 'vocabulary-name-only', 'allNodeTypesSupported': None,
             'consumerCandidates': locations(files, r'(?<![\w$])' + re.escape(field) + r'(?![\w$])', product, 20),
             'runtimeCoverage': 'not-measured'} for field in sorted(names)]


def test_graph(files):
    package = json.loads(files['package.json'])
    scripts = package.get('scripts', {})
    direct = {name: sorted(set(re.findall(r'(?<![\w/])(test/[\w./-]+\.(?:mjs|js|py))', value)))
              for name, value in scripts.items()}
    workflows = []
    invoked = set()
    for path in files:
        if not path.startswith('.github/workflows/'):
            continue
        for line, text in enumerate(files[path].splitlines(), 1):
            match = re.search(r'\brun:\s*(.+)', text)
            if not match:
                continue
            command = match.group(1).strip()
            targets = re.findall(r'\bnpm run ([\w:-]+)', command)
            if re.search(r'\bnpm test\b', command):
                targets.append('test')
            invoked.update(targets)
            workflows.append({'path': path, 'line': line, 'command': command, 'packageScripts': targets})
    aggregations = []
    # Confirm the inspected loop actually invokes this literal list, instead of
    # treating all strings or release-manifest entries as subprocess execution.
    core = files.get('test/regression.mjs', '')
    match = re.search(r'const suites\s*=\s*\[(.*?)\];\s*for\s*\(const file of suites\)\s*\{\s*const result = run\(file\)', core, re.S)
    if match:
        for child in re.findall(r"['\"](test/[^'\"]+)['\"]", match.group(1)):
            aggregations.append({'from': 'test/regression.mjs', 'to': child,
                                 'kind': 'reviewed-static-subprocess-list',
                                 'line': core[:match.start()].count('\n') + 1})
    ci_files = set(f for script in invoked for f in direct.get(script, []))
    changed = True
    while changed:
        old = set(ci_files)
        ci_files.update(edge['to'] for edge in aggregations if edge['from'] in ci_files)
        changed = old != ci_files
    tests = []
    for path in sorted(p for p in files if p.startswith('test/') and p.endswith(('.mjs', '.js', '.py'))):
        text = files[path]
        names = [{'line': i, 'name': m.group(1)} for i, line in enumerate(text.splitlines(), 1)
                 for m in [re.search(r"\b(?:test|check)\(\s*['\"]([^'\"]+)", line)] if m]
        tests.append({'path': path, 'packageScripts': [n for n, paths in direct.items() if path in paths],
                      'ciReachableByReviewedStaticGraph': path in ci_files,
                      'aggregationParents': [e['from'] for e in aggregations if e['to'] == path],
                      'testTitles': names,
                      'conditionalOrSkipReferences': locations(files, r'\bskip\s*:|\.skip\(|requires local|process\.platform|browserAvailable', [path], 12),
                      'runtimeStatusThisAudit': 'not-run',
                      'note': 'Static dispatch does not prove execution, platform availability, assertions or success.'})
    return {'packageScripts': scripts, 'directTestDispatch': direct, 'ciRunSteps': workflows,
            'reviewedAggregations': aggregations, 'tests': tests,
            'summary': {'testFiles': len(tests), 'packageDispatched': sum(bool(t['packageScripts']) for t in tests),
                        'ciReachable': sum(t['ciReachableByReviewedStaticGraph'] for t in tests),
                        'actuallyExecutedThisAudit': 0}}


FEATURES = [
    ('transactions', ['studio-reliability', 'studio-consistency', 'studio-contracts']),
    ('semantic-query', ['studio-authoring-query', 'studio-contracts']),
    ('rp1-local-authoring', ['studio-rp1-authoring', 'studio-trial-regressions', 'studio-benchmark-trials']),
    ('selection-and-editing', ['studio-editing', 'studio-clipboard-browser']),
    ('macro-and-instance-control', ['studio-authoring-query', 'studio-audit-repairs', 'studio-native-sync']),
    ('typography-and-long-content', ['studio-audit-repairs', 'studio-trial-regressions', 'studio-benchmark-trials']),
    ('assets-and-media', ['studio-design-workflow', 'studio-bundle-merge', 'studio-benchmark-trials']),
    ('visual-css-and-quality', ['studio-css', 'studio-pixel-contrast', 'studio-design-metrics', 'studio-vector-boolean']),
    ('candidates-and-states', ['studio-ceiling', 'studio-explore']),
    ('stage-design-context', ['studio-design-guidance', 'studio-design-workflow']),
    ('project-design-decisions', ['studio-design-decision', 'studio-bundle-merge']),
    ('runtime-interaction', ['studio-ceiling', 'studio-trial-regressions', 'studio-benchmark-trials']),
    ('undo-and-recovery', ['studio-reliability', 'studio-consistency', 'studio-editing']),
    ('native-export', ['studio-css', 'studio-trial-regressions', 'studio-native-sync', 'studio-vector-boolean']),
    ('large-document-performance', ['studio-performance']),
    ('portable-project-and-concurrency', ['studio-consistency', 'studio-bundle-merge', 'studio-export-code']),
]


def coverage(graph):
    dimensions = {'entry': ['document-store', 'mcp-stdio', 'cli', 'browser-ui'],
                  'recovery': ['none', 'reload', 'process-restart', 'crash-wal'],
                  'scale': ['small', '1k', '5k', '10k'],
                  'output': ['source', 'browser-render', 'rp-structure', 'axure-load', 'axure-preview', 'gui-save-reopen']}
    features = [{'id': name, 'testSourceCandidates': [t['path'] for t in graph['tests'] if any(key in t['path'] for key in keys)],
                 'status': 'static-candidates-only', 'historicalEvidence': 'external-history-index.json',
                 'note': 'No cross-product cell inherits a pass from these source references.'}
                for name, keys in FEATURES]
    cells = [dict(feature=f['id'], **dict(zip(dimensions, values)), status='not-measured', evidenceIds=[])
             for f in features for values in itertools.product(*dimensions.values())]
    return {'schemaVersion': 1, 'dimensions': dimensions, 'features': features, 'cells': cells,
            'summary': {'requiredCrossProductCells': len(cells), 'measuredThisAudit': 0, 'passedThisAudit': 0},
            'policy': 'not-measured is not a failure or unsupported claim; decide applicability explicitly before running, retaining the reason. Static citations and historic claims cannot turn cells green.'}


def negatives(records):
    items = []
    for r in records:
        name = r['command']
        required = (r['contractSchema'] or {}).get('required', [])
        items.append({'command': name, 'case': 'unknown-command-field', 'status': 'required-not-executed',
                      'expected': 'Explicit rejection, no document/hash/revision change; missing detailed contracts remain a known C01 gap.',
                      'detailedContractExists': r['detailedContract']})
        for field in required:
            if field != 'type':
                items.append({'command': name, 'case': 'missing-required-field', 'field': field,
                              'status': 'required-not-executed', 'expected': 'Explicit rejection or documented alternative field; no partial commit.'})
        if any(k in r['readFieldsCandidate'] for k in ('nodeId', 'parentId', 'pageId', 'select')):
            for case in ('unknown-target', 'ambiguous-cross-page-target', 'empty-selection', 'stale-selection'):
                items.append({'command': name, 'case': case, 'status': 'required-not-executed',
                              'expected': 'No fallback to broader page/project; reject invalid binding and preserve unselected content.'})
    global_cases = ['empty-command-batch', 'invalid-nested-property', 'conflicting-aliases',
                    'unknown-node-property', 'unsupported-node-property-semantics', 'locked-target',
                    'macro-expanded-target', 'instance-target-must-not-change-definition',
                    'stale-base-revision', 'same-key-different-payload', 'lost-write-response',
                    'unsupported-or-zero-assertion-scenario', 'missing-font-or-asset',
                    'persist-restart-undo-redo', 'failed-export-does-not-claim-native-success']
    return {'schemaVersion': 1, 'perCommand': items,
            'crossCutting': [{'case': case, 'status': 'required-not-executed'} for case in global_cases],
            'note': 'Required cases are an audit backlog, not newly implemented tests or claims of current rejection behavior.'}


def history_index(workspace):
    root = 'outputs/canvas-ai-moat-20261028/'
    trials = [('original-assisted', ['independent-trial/calls.jsonl', 'independent-trial/reconnected/calls.jsonl'], 'independent-trial/REPORT.md', 'assisted', 5),
              ('second-independent', ['independent-retry/calls.jsonl'], 'independent-retry/REPORT.md', 'independent', 7),
              ('same-caller-followup', ['independent-followup/calls.jsonl'], 'independent-followup/REPORT.md', 'familiar', 8)]
    records = []
    for name, ledgers, report, experience, score in trials:
        files = []
        for rel in ledgers + [report]:
            path = workspace / (root + rel) if workspace else None
            record = {'path': root + rel, 'relativeTo': 'workspaceRoot', 'existsAtAudit': bool(path and path.exists()), 'sha256': None}
            if path and path.exists():
                data = path.read_bytes()
                record['sha256'] = digest(data)
                if rel.endswith('.jsonl'):
                    rows = [json.loads(line) for line in data.decode().splitlines() if line.strip()]
                    record['ledgerRows'] = len(rows)
            files.append(record)
        records.append({'id': name, 'experience': experience, 'historicalAgentScore': score,
                        'provenance': 'historical-report-not-reexecuted', 'files': files})
    return {'schemaVersion': 1, 'trials': records,
            'note': 'Original 5/10, independent 7/10 and familiar followup 8/10 are distinct historical runs. Scores and old schemas are not this audit results or strict A/B.'}


def inventory(args):
    root, out = args.root.resolve(), args.out.resolve()
    if root == out or root in out.parents and out.relative_to(root).parts[0] in {'studio', 'test', 'scripts', 'bin', '.github'}:
        raise ValueError('Output must not overwrite product/test source')
    files = sources(root)
    frozen_manifest = root / 'manifest.json'
    if args.label == 'baseline' and frozen_manifest.exists():
        for record in json.loads(frozen_manifest.read_text())['files']:
            path = root / record['path']
            if not path.exists() or digest(path.read_bytes()) != record['sha256']:
                raise ValueError('Frozen baseline drift: ' + record['path'])
    before = fingerprint(files)
    detailed = contracts(root)
    groups, commands, fields, undeclared = command_inventory(files, detailed)
    props = node_fields(files)
    graph = test_graph(files)
    # Detect concurrent mutation rather than silently combining revisions.
    after = fingerprint(sources(root))
    if before != after:
        raise ValueError('Source changed during inventory; rerun current audit after edits settle')
    summary = {'schemaVersion': 1, 'label': args.label,
               'generatedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
               'sourceTreeSha256': before['treeSha256'], 'commandCount': len(commands),
               'detailedContractCount': len(detailed), 'nodePropertyCount': len(props),
               'missingDetailedContracts': [r['command'] for r in commands if not r['detailedContract']],
               'unregisteredHandlers': undeclared,
               'contractNamesNotInRegistry': sorted(set(detailed) - {r['command'] for r in commands}),
               'staticOnly': True, 'productRuntimeTestsExecuted': 0,
               'testDispatch': graph['summary']}
    if args.baseline:
        baseline = json.loads(args.baseline.read_text())
        old_commands_path = args.baseline.parent / 'commands.json'
        old_names = {r['command'] for r in json.loads(old_commands_path.read_text())['commands']}
        now = {r['command'] for r in commands}
        summary['baselineComparison'] = {'baselineSourceTreeSha256': baseline['sourceTreeSha256'],
                                         'baselineCommandCount': baseline['commandCount'],
                                         'currentCommandCount': len(commands), 'addedCommands': sorted(now - old_names),
                                         'removedCommands': sorted(old_names - now),
                                         'baselineDetailedContractCount': baseline['detailedContractCount'],
                                         'currentDetailedContractCount': len(detailed)}
    out.mkdir(parents=True, exist_ok=True)
    write(out / 'source-hashes.json', before)
    write(out / 'inventory.json', summary)
    write(out / 'commands.json', {'schemaVersion': 1, 'groups': groups, 'commands': commands})
    write(out / 'command-fields.json', {'schemaVersion': 1, 'fields': fields, 'note': 'Declaration, static read and actual runtime coverage are separate states.'})
    write(out / 'node-fields.json', {'schemaVersion': 1, 'fields': props})
    write(out / 'test-entrypoints.json', graph)
    write(out / 'coverage-matrix.json', coverage(graph))
    write(out / 'negative-cases.json', negatives(commands))
    write(out / 'external-history-index.json', history_index(args.workspace_root))
    (out / 'README.md').write_text(
        '# Studio 静态基线盘点\n\n'
        f"标签：{args.label}；命令 {len(commands)}，详细契约 {len(detailed)}，属性词表 {len(props)}。\n\n"
        f"源指纹：`{before['treeSha256']}`。\n\n"
        '命令字段位置、UI引用与测试标题仅为静态线索，不代表字段已执行或所有节点都支持。'
        'test-entrypoints.json 列出 package/CI 调用链；条件跳过需在实际日志确认。'
        '本轮未运行产品测试或8题创作，coverage-matrix 全部保持 not-measured。'
        '历史试用原始账本仅登记路径、SHA与行数，不改写评分，不混入本轮通过率。\n')
    print(json.dumps(summary, ensure_ascii=False))


def snapshot(args):
    root, out = args.root.resolve(), args.out.resolve()
    if out.exists():
        raise ValueError('Snapshot target already exists; refusing to overwrite a baseline')
    files = sources(root)
    manifest = fingerprint(files)
    for path, text in files.items():
        target = out / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
    manifest['capturedAt'] = dt.datetime.now(dt.timezone.utc).isoformat()
    write(out / 'manifest.json', manifest)
    print(json.dumps({'snapshotFiles': len(files), 'treeSha256': manifest['treeSha256']}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['snapshot', 'inventory'])
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--label', choices=['baseline', 'current'], default='current')
    parser.add_argument('--baseline', type=Path)
    parser.add_argument('--workspace-root', type=Path)
    args = parser.parse_args()
    if args.action == 'snapshot':
        snapshot(args)
    else:
        inventory(args)


if __name__ == '__main__':
    main()
