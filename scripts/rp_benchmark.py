#!/usr/bin/env python3
"""Frozen requirements and evidence-bounded trial accounting; never manufactures scores."""
import argparse
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'benchmarks/rp1/v1'


def load(root=ROOT):
    manifest = json.loads((root / 'manifest.json').read_text())
    tasks = []
    for name, digest in manifest['files'].items():
        if hashlib.sha256((root / name).read_bytes()).hexdigest() != digest:
            raise ValueError('Frozen benchmark changed: ' + name)
        group = json.loads((root / name).read_text())
        assert len(group) == manifest[Path(name).stem]
        assert all(t['partition'] == Path(name).stem and len(t['acceptance']) >= 3 for t in group)
        tasks.extend(group)
    assert len(tasks) == manifest['tasks'] == len({t['id'] for t in tasks}) == 30
    return manifest, tasks


def report(trials, tasks):
    required = {'taskId', 'trial', 'model', 'sourceHash', 'firstGenerationPass', 'repairRounds',
                'manualEdits', 'elapsedSeconds', 'rpHash', 'nativeBehavior', 'guiSaveReopen',
                'guiEdit', 'visualReview', 'evidence'}
    seen = set()
    for r in trials:
        if required - r.keys():
            raise ValueError('Missing trial fields: ' + ','.join(sorted(required - r.keys())))
        key = (r['taskId'], r['trial'])
        if r['taskId'] not in {t['id'] for t in tasks} or type(r['trial']) is not int or r['trial'] not in (1, 2, 3) or key in seen:
            raise ValueError('Unknown or duplicate trial: ' + str(key))
        for field in ('firstGenerationPass', 'nativeBehavior', 'guiSaveReopen', 'guiEdit', 'visualReview'):
            if type(r[field]) is not bool:
                raise ValueError(field + ' must be a measured boolean')
        if not isinstance(r['evidence'], list) or not r['evidence'] or not all(isinstance(e, str) and e for e in r['evidence']) or not all(isinstance(r[k], str) and re.fullmatch('[0-9a-f]{64}', r[k]) for k in ('sourceHash', 'rpHash')):
            raise ValueError('Trial requires source, RP hashes and evidence paths')
        if any(type(r[k]) not in (int, float) or r[k] < 0 for k in ('repairRounds', 'manualEdits', 'elapsedSeconds')):
            raise ValueError('Trial counts and durations must be nonnegative')
        if any(type(r[k]) is not int for k in ('repairRounds', 'manualEdits')):
            raise ValueError('Trial counts must be integers')
        if r['firstGenerationPass'] and (r['repairRounds'] or r['manualEdits'] or not all(r[k] for k in ('nativeBehavior', 'guiSaveReopen', 'guiEdit', 'visualReview'))):
            raise ValueError('First-generation pass contradicts repairs or failed acceptance')
        seen.add(key)
    n = len(trials)
    return {'recordedTrials': n, 'requiredTrials': 90, 'missingTrials': 90 - n,
            'firstGenerationPassRate': sum(r['firstGenerationPass'] for r in trials) / n if n else None,
            'completeEvidencePassRate': sum(all(r[k] for k in ('nativeBehavior', 'guiSaveReopen', 'guiEdit', 'visualReview')) for r in trials) / n if n else None,
            'manualEdits': sum(r['manualEdits'] for r in trials), 'score': None,
            'note': 'No score inferred from compiler tests or missing human evidence.'}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('command', choices=['verify', 'prompt', 'report'])
    p.add_argument('--task')
    p.add_argument('--trials', type=Path)
    args = p.parse_args()
    manifest, tasks = load()
    if args.command == 'verify':
        result = {'pass': True, 'tasks': len(tasks), 'development': 20, 'heldout': 10, 'version': manifest['version']}
    elif args.command == 'prompt':
        task = next(t for t in tasks if t['id'] == args.task)
        result = {k: task[k] for k in ['id', 'title', 'prompt']}
    else:
        if not args.trials:
            p.error('report requires --trials')
        result = report(json.loads(args.trials.read_text()), tasks)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
