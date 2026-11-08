// 文本输入框按 Enter 不触发 change（仅失焦且值变化才触发），所以 Enter 与 change 共用同一条提交路径；
// 提交前先记下已提交值做同值去抖，避免 Enter 后紧跟的 blur/change 重复提交同一值。
export function bindCommitOnEnter(el, commit) {
  if (!el) return;
  let committed = String(el.value ?? '');
  const submit = async () => {
    const value = String(el.value ?? '');
    if (value === committed) return;
    const previous = committed;
    committed = value;
    let ok = true;
    try {
      ok = (await commit(value)) !== false;
    } catch (err) {
      ok = false;
      throw err;
    } finally {
      if (!ok) committed = previous;
    }
  };
  el.addEventListener('change', () => { submit().catch(() => {}); });
  if (el.tagName === 'INPUT' && /^(text|number|search|url|tel)$/.test(el.type)) {
    el.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      submit().catch(() => {});
    });
  }
}
