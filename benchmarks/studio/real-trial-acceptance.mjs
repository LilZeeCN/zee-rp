// Only actor-originated receipts count as author behavior; the harness replay is separate.
export function checkActorEvidence(taskId, receipts, feedback, finalHash, taskScenarios = [], initialBinding = null) {
  const successful = name => receipts.filter(r => r.request?.name === name && r.row?.status === 'success' && r.result?.ok !== false);
  const screenshotReceipts = receipts.filter(r => ['studio_screenshot'].includes(r.request?.name) || (r.request?.name === 'studio_design' && r.request?.args?.action === 'review')
    && r.row?.status === 'success' && r.result?.ok !== false && r.images?.length);
  const finalScreenshot = screenshotReceipts.some(r => r.result?.contentHash === finalHash);
  const subset = (required, actual) => {
    if (required && typeof required === 'object' && !Array.isArray(required)) return actual && typeof actual === 'object' && Object.entries(required).every(([key,value]) => subset(value, actual[key]));
    if (Array.isArray(required)) return Array.isArray(actual) && required.length === actual.length && required.every((value,i) => subset(value, actual[i]));
    return required === actual;
  };
  const scenarioReceipts = successful('studio_scenario').filter(r => !r.request?.args?.acceptance).filter(r => r.result?.ok === true && (r.result.assertionCount || 0) > 0);
  const scenario = taskScenarios.length > 0 && taskScenarios.every(expected => scenarioReceipts.some(receipt => {
    const args = receipt.request.args || {};
    if ((args.startPageId || 'home') !== (expected.startPageId || 'home') || (expected.reset === true && args.reset === false)) return false;
    let at = 0;
    for (const step of args.steps || []) {
      const want = expected.steps[at];
      if (!want) break;
      const targetMatches = !want.target || step.target === want.target || String(step.target || '').endsWith('/' + want.target);
      const requiredFields = Object.fromEntries(Object.entries(want).filter(([key]) => key !== 'target'));
      if (targetMatches && subset(requiredFields, step)) at++;
    }
    return at === expected.steps.length;
  }));
  const checks = { finalScreenshot, scenario, feedback: Boolean(feedback && typeof feedback.easeScore === 'number') };
  if (taskId === 'T08') {
    const atomic = successful('studio_command').find(r => {
      const ids = r.result?.directAffectedNodeIds || [];
      return ['home/title', 'home/card', 'home/instanceA'].every(id => ids.includes(id));
    });
    const tx = atomic?.result?.txId, editedHash = atomic?.result?.contentHash;
    const undo = successful('studio_history').filter(r => r.request?.args?.action === 'undo').find(r => r.result?.undoneTxId === tx);
    const redo = successful('studio_history').filter(r => r.request?.args?.action === 'redo').find(r => r.result?.redoneTxId === tx && r.result?.contentHash === editedHash);
    const ai = receipts.indexOf(atomic), ui = receipts.indexOf(undo), ri = receipts.indexOf(redo);
    const screenshot = (start, end, hash) => receipts.slice(start, end).some(r => ['studio_screenshot'].includes(r.request?.name) || (r.request?.name === 'studio_design' && r.request?.args?.action === 'review')
      && r.row?.status === 'success' && r.images?.length && r.result?.contentHash === hash);
    const initialHash = initialBinding?.contentHash;
    const before = Boolean(initialHash && undo?.result?.contentHash === initialHash && ai >= 0 && screenshot(0, ai, initialHash));
    const edited = ai >= 0 && ui > ai && screenshot(ai + 1, ui, editedHash);
    const undone = ui >= 0 && ri > ui && screenshot(ui + 1, ri, undo?.result?.contentHash);
    const redone = ri >= 0 && screenshot(ri + 1, receipts.length, editedHash);
    const empty = receipts.some(r => {
      const args = r.request?.args || {};
      const emptySelection = args.target?.nodeIds?.length === 0
        || (Array.isArray(args.commands) && (
          args.commands.length === 0
          || args.commands.some(command => command.select?.nodeIds?.length === 0)
        ));
      const rejected = r.row?.status === 'error' && emptySelection
        && ['E_TRIAL_TOOL','E_EMPTY_SELECTION','E_INVALID_INPUT','E_COMMAND_VALUE'].includes(r.result?.code)
        && /nodeIds|selection|选择|至少|empty/i.test(r.result?.message || '');
      const unmatchedQuery = r.request?.name === 'studio_inspect'
        && r.row?.status === 'success'
        && r.result?.ok !== false
        && r.result?.empty === true
        && r.result?.contentHash === finalHash;
      return rejected || unmatchedQuery;
    });
    const stale = receipts.some(r => r.row?.status === 'error'
      && r.result?.code === 'E_STALE_REVISION'
      && r.result?.currentContentHash
      && r.result.currentContentHash !== initialHash);
    Object.assign(checks, { atomic: Boolean(tx && editedHash && before && edited), undo: Boolean(undo && undone && undo.result.contentHash !== editedHash), redo: Boolean(redo && redone && editedHash === finalHash), emptySelection: empty, staleSelection: stale });
  }
  return { passed: Object.values(checks).every(Boolean), checks };
}

// Browser observations come from the replay's real DOM at each state, never from document metadata.
export function checkObservedContent(taskId, browserScenarios, content) {
  if (!['T01', 'T02'].includes(taskId)) return { passed: true, applicable: false, missing: [] };
  const snapshots = browserScenarios.flatMap(s => (s.result?.history || []).map(step => (step.actual?.widgets || [])
    .filter(widget => widget.visible && typeof widget.text === 'string').map(widget => widget.text).join('\n')));
  const combined = snapshots.join('\n');
  const required = taskId === 'T01'
    ? content.words.flatMap(word => [word.word, word.phonetic, word.partOfSpeech, word.definition, word.example])
    : [content.article.title, content.article.author, content.article.date, content.article.source, content.article.footnote,
       ...content.article.sections.flatMap(section => [section.heading, ...section.paragraphs])];
  const missing = required.filter(text => !combined.includes(text));
  const paragraphs = content.article.sections.flatMap(section => section.paragraphs);
  const ordered = taskId !== 'T02' || snapshots.some(snapshot => {
    let position = -1;
    return paragraphs.every(paragraph => { const next = snapshot.indexOf(paragraph, position + 1); if (next < 0) return false; position = next; return true; });
  });
  return { passed: snapshots.length > 0 && missing.length === 0 && ordered, applicable: true, missing, paragraphOrder: ordered, observations: snapshots.length };
}
