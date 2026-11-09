import { showToast } from './ui.mjs';
import { state } from './state.mjs';

async function postJson(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    throw Object.assign(new Error(data.message || 'API Error'), { data });
  }
  return data;
}

export function createEditorRequests({ applyServerSnapshot, onRequestError }) {
  let commandQueue = Promise.resolve();
  let lastSelectionKey = '';
  let selectionPublishTimer = null;
  let selectionPublishQueue = Promise.resolve();

  async function apiPost(path, body) {
    try {
      const data = await postJson(path, body);
      state.lastError = null;
      return data;
    } catch (error) {
      if (Object.hasOwn(error, 'data')) {
        state.lastError = error.data;
        onRequestError();
      }
      throw error;
    }
  }

  function enqueue(run) {
    const result = commandQueue.then(run);
    commandQueue = result.catch(err => { showToast(err.message, 'error'); });
    return result;
  }

  function dispatchCommands(commands, options = {}) {
    return enqueue(async () => {
      const { idempotencyKey = null, baseRevision = null } = options;
      const cmdList = Array.isArray(commands) ? commands : [commands];
      const rev = baseRevision !== null ? baseRevision : state.appliedRevision;
      const idem = idempotencyKey || `${state.clientId}_${rev}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const res = await apiPost('/api/commands', {
        clientId: state.clientId,
        source: 'human-web',
        baseRevision: rev,
        idempotencyKey: idem,
        commands: cmdList,
      });
      if ((res.doc && res.scene) || res.scenePatch) {
        await applyServerSnapshot(res);
      }
      return res;
    });
  }

  function dispatchHistoryAction(endpoint) {
    return enqueue(async () => {
      if (state.mode === 'interact') {
        // 预览运行态是只读态：撤销/重做会回滚设计文档，此处直接禁用并提示（T-D-1）。
        const label = endpoint === '/api/undo' ? '撤销' : '重做';
        showToast(`预览运行态为只读，${label}已禁用；请退出预览后再试`, 'warn', 3800);
        return null;
      }
      const res = await apiPost(endpoint, { clientId: state.clientId });
      if (res.doc && res.scene) {
        await applyServerSnapshot(res);
      }
      return res;
    });
  }

  function publishSelection() {
    if (!state.doc || !state.activePageId) return;
    const body = {
      clientId: state.clientId,
      documentId: state.doc.documentId,
      pageId: state.activePageId,
      revision: state.appliedRevision,
      contentHash: state.doc.contentHash,
      nodeIds: [...state.selectedIds],
    };
    const key = JSON.stringify(body);
    if (key === lastSelectionKey) return;
    lastSelectionKey = key;
    clearTimeout(selectionPublishTimer);
    selectionPublishTimer = setTimeout(() => {
      selectionPublishQueue = selectionPublishQueue.catch(() => {})
        .then(() => apiPost('/api/selection', body))
        .then(result => { state.selectionId = result.selectionId || null; })
        .catch(() => { state.selectionId = null; });
    }, 40);
  }

  return {
    apiPost,
    dispatchCommands,
    dispatchHistoryAction,
    waitForCommands: () => commandQueue,
    publishSelection,
    resetLastSelectionKey: () => { lastSelectionKey = ''; },
  };
}
