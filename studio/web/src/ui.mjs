export let toastTimer = null;

export function showToast(message, tone = 'info', durationMs = 3800) {
  window.__STUDIO_LAST_TOAST__ = { message, tone, timestamp: Date.now() };
  const el = document.getElementById('studio-toast');
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
  el.style.borderColor = tone === 'error' ? '#e05252' : tone === 'warn' ? '#e5a93c' : '#3b9b78';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.style.display = 'none';
  }, durationMs);
}

export function renderIconSvg(iconName, color = '#203B32', size = 18) {
  const s = Math.max(12, Math.min(32, Number(size) || 18));
  const stroke = escapeHtml(color || '#203B32');
  const key = String(iconName || '').toLowerCase();
  let inner = '';
  if (key.includes('search')) {
    inner = `<circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />`;
  } else if (key === 'home' || key.includes('house')) {
    inner = `<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" />`;
  } else if (key.includes('layers') || key.includes('stack')) {
    inner = `<polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" />`;
  } else if (key.includes('arrow-up-right') || key.includes('external')) {
    inner = `<line x1="7" y1="17" x2="17" y2="7" /><polyline points="7 7 17 7 17 17" />`;
  } else if (key.includes('camera')) {
    inner = `<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" />`;
  } else if (key.includes('spark') || key.includes('star')) {
    inner = `<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />`;
  } else if (key.includes('compass') || key.includes('explore')) {
    inner = `<circle cx="12" cy="12" r="10" /><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />`;
  } else if (key.includes('book') || key.includes('journal')) {
    inner = `<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />`;
  } else if (key.includes('user') || key === 'me') {
    inner = `<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />`;
  } else if (key.includes('map') || key.includes('pin') || key.includes('spot')) {
    inner = `<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" />`;
  } else if (key.includes('heart') || key.includes('fav')) {
    inner = `<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />`;
  } else if (key.includes('plus') || key.includes('add')) {
    inner = `<line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />`;
  } else if (key.includes('check')) {
    inner = `<polyline points="20 6 9 17 4 12" />`;
  } else if (key.includes('chevron-left') || key.includes('back')) {
    inner = `<polyline points="15 18 9 12 15 6" />`;
  } else if (key.includes('chevron-right') || key.includes('next')) {
    inner = `<polyline points="9 18 15 12 9 6" />`;
  } else {
    inner = `<circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2.5" fill="${stroke}" />`;
  }
  return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;pointer-events:none;">${inner}</svg>`;
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function isInputFocused() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = (el.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function uiIcon(name) {
  return `<svg class="ui-icon" aria-hidden="true" focusable="false"><use href="#ui-${escapeHtml(name)}"></use></svg>`;
}
