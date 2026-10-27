import type { BrowserManager } from './browser.js';
export async function instanceDocument(
  manager: BrowserManager,
  id: string,
  base: string,
  owner?: string,
) {
  const details =
    owner === undefined
      ? await manager.adminInstanceDetails(id)
      : await manager.ownedInstanceDetails(owner, id);
  const logs = details.logs_available
    ? owner === undefined
      ? await manager.logs.adminInstanceLogs(id, { limit: 200 })
      : {
          instance: manager.logs.get(owner, id),
          ...(await manager.logs.query(owner, { instance_id: id, limit: 200 })),
        }
    : null;
  const root = base.replace(/\/$/, '');
  const navigation = details.logs_available
    ? owner === undefined
      ? await manager.logs.adminNavigation(id, { limit: 200 })
      : await manager.logs.navigation(owner, id, { limit: 200 })
    : null;
  return {
    ...details,
    logs,
    navigation,
    links: {
      details: details.details_url,
      logs: `${root}/api/instances/${id}/logs?access_token=`,
      navigation: `${root}/api/instances/${id}/navigation?access_token=`,
      live_frame: details.current ? `${root}/api/instances/${id}/frame?access_token=` : null,
      live: details.current ? `${root}/api/instances/${id}/live?access_token=` : null,
      recordings: details.recordings.map((r) => ({
        recording_id: r.id,
        url: `${root}/api/recordings/${r.id}/video?access_token=`,
      })),
    },
  };
}
type Document = Awaited<ReturnType<typeof instanceDocument>>;
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function instanceDocumentHtml(doc: Document) {
  return `<main class="instance-document"><h1>实例详情 ${escape(doc.instance.instance_id)}</h1><h2>状态与属性</h2><pre>${escape(JSON.stringify({ instance: doc.instance, current: doc.current, pages: doc.pages }, null, 2))}</pre><h2>直播与录屏</h2><pre>${escape(JSON.stringify({ recordings: doc.recordings, links: doc.links }, null, 2))}</pre><h2>跳转历史</h2><pre>${escape(JSON.stringify(doc.navigation, null, 2))}</pre><h2>调用日志</h2><pre>${escape(JSON.stringify(doc.logs, null, 2))}</pre></main>`;
}
export function instanceDocumentMarkdown(doc: Document) {
  return `# 实例详情 ${doc.instance.instance_id}\n\n## 状态与属性\n\n\`\`\`json\n${JSON.stringify({ instance: doc.instance, current: doc.current, pages: doc.pages }, null, 2)}\n\`\`\`\n\n## 直播与录屏\n\n\`\`\`json\n${JSON.stringify({ recordings: doc.recordings, links: doc.links }, null, 2)}\n\`\`\`\n\n## 跳转历史\n\n\`\`\`json\n${JSON.stringify(doc.navigation, null, 2)}\n\`\`\`\n\n## 调用日志\n\n\`\`\`json\n${JSON.stringify(doc.logs, null, 2)}\n\`\`\`\n`;
}
