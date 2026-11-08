import { showToast } from './ui.mjs';
import { applyServerSnapshot } from './sync.mjs';
import { renderInspector } from './inspector.mjs';
import { state } from './state.mjs';

export async function apiPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    state.lastError = data;
    renderInspector();
    throw Object.assign(new Error(data.message || 'API Error'), { data });
  }
  state.lastError = null;
  return data;
}

export let commandQueue = Promise.resolve();

export function dispatchCommands(commands, options = {}) {
  const run = async () => {
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
  };
  const result = commandQueue.then(run);
  commandQueue = result.catch(err => { showToast(err.message, 'error'); });
  return result;
}

export function dispatchHistoryAction(endpoint) {
  const run = async () => {
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
  };
  const result = commandQueue.then(run);
  commandQueue = result.catch(err => { showToast(err.message, 'error'); });
  return result;
}
