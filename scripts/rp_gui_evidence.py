"""Verify GUI editing evidence without inferring GUI actions from file structure."""
import hashlib
import json
from pathlib import Path


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def widgets(summary):
    entries = [w for p in summary.get('pages', []) for w in p.get('widgets', [])] + summary.get('containedWidgets', [])
    return {(w.get('record'), w.get('id'), w.get('name')): w for w in entries}.values()


def interactive(widget):
    return widget.get('type') in {'TextBox', 'TextArea', 'Checkbox', 'RadioButton', 'ComboBox', 'ListBox'} or any(
        event.get('event') in {'OnClick', 'OnDoubleClick', 'OnMouseDown', 'OnMouseUp', 'OnTextChange', 'OnSelectionChange'}
        and not event.get('disabled') and any(not case.get('disabled') and any(not action.get('disabled') for action in case.get('actions', []))
                                               for case in event.get('cases', [])) for event in widget.get('interactions', []))


def verify_gui_evidence(original, edited, roundtrip, preview, proof, edited_path):
    reasons = []
    artifact_hash = file_hash(edited_path)
    validation = roundtrip.get('validation', {})
    if any(edited.get('counts', {}).get(k) != 0 for k in ('problems', 'danglingRefs', 'sentinelSlotsNonZero')):
        reasons.append('edited_structure_failed')

    if not all(validation.get(k) is True for k in ('structure', 'guiSaved', 'closed', 'reopened')):
        reasons.append('native_save_close_reopen_missing')
    if roundtrip.get('outputSha256') != artifact_hash or Path(roundtrip.get('output', '')).resolve() != Path(edited_path).resolve():
        reasons.append('roundtrip_artifact_mismatch')
    by_name = {w['name']: w for w in widgets(original) if w.get('name')}
    after = {w['name']: w for w in widgets(edited) if w.get('name')}
    if proof.get('method') != 'cua' or proof.get('editedRpSha256') != artifact_hash:
        reasons.append('gui_edit_proof_missing_or_stale')
    for role in ('title', 'control'):
        target = proof.get(role, {})
        name = target.get('name')
        before, current = by_name.get(name), after.get(name)
        if not before or not current or before.get('text') == current.get('text') or current.get('text') != target.get('after') or before.get('text') != target.get('before'):
            reasons.append(role + '_edit_not_verified')
            continue
        if role == 'control' and (not interactive(before) or not interactive(current)):
            reasons.append('control_is_not_interactive')
        if before.get('interactions', []) != current.get('interactions', []):
            reasons.append(role + '_interactions_changed')
    if proof.get('title', {}).get('name') == proof.get('control', {}).get('name'):
        reasons.append('distinct_edit_targets_required')
    if preview.get('pass') is not True or preview.get('rpArtifact', {}).get('sha256') != artifact_hash or not preview.get('results') or any(r.get('pass') is not True for r in preview['results']):
        reasons.append('edited_artifact_preview_missing_or_stale')
    return {'pass': not reasons, 'reasons': reasons, 'editedRpSha256': artifact_hash,
            'guiSaveReopen': not any(r.startswith(('native_', 'roundtrip_', 'edited_structure_')) for r in reasons)}


def verify_trial_gui(trial_dir):
    """Read actual binaries; sidecar summaries cannot manufacture edits."""
    import subprocess
    root = Path(trial_dir)
    scripts = Path(__file__).resolve().parent
    original_path = root / 'final.rp'
    edited_path = root / 'final-gui-edited.rp'
    if not original_path.exists() or not edited_path.exists():
        return {'pass': False, 'guiSaveReopen': False, 'reasons': ['artifact_missing']}
    def read_rp(p):
        return json.loads(subprocess.check_output(['node', str(scripts / 'rp-read.mjs'), str(p), '--json', '--include-master-widgets'], text=True))
    def read_json(name):
        p = root / name
        return json.loads(p.read_text()) if p.exists() else {}
    return verify_gui_evidence(read_rp(original_path), read_rp(edited_path),
        read_json('gui-native-roundtrip.json'), read_json('edited-preview-verify.json'),
        read_json('gui-edit-proof.json'), edited_path)
