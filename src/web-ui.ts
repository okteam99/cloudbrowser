const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export type SharedView = {
  kind: 'live' | 'recording';
  state: 'live' | 'ready' | 'ended' | 'unavailable';
  expires_at: string;
  media_url: string;
  frame_url?: string;
  status_url: string;
};
function shell(
  base: string,
  screen: 'login' | 'dashboard' | 'share',
  error = '',
  csrf = '',
  share?: SharedView,
) {
  const data = JSON.stringify({ base, screen, error, csrf, share }).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0b1427"><title>cloudbrowser${screen === 'login' ? ' · 登录' : screen === 'share' ? ' · 公开观看' : ''}</title><link rel="stylesheet" href="${escapeHtml(base)}/assets/app.css"></head><body><div id="root"><div class="initial-loading">${screen === 'login' ? '正在加载访问密码登录页…' : screen === 'share' ? '正在加载观看页…' : '正在加载浏览器控制台…'}</div></div><noscript>请启用 JavaScript 查看页面。</noscript><script id="bootstrap" type="application/json">${data}</script><script defer src="${escapeHtml(base)}/assets/app.js"></script></body></html>`;
}
export function loginPage(base: string, error = '') {
  return shell(base, 'login', error);
}
export function dashboard(base: string, csrf: string) {
  return shell(base, 'dashboard', '', csrf);
}
export function sharePage(base: string, share?: SharedView) {
  return shell(base, 'share', '', '', share);
}
