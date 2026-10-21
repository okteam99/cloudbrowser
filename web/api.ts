export type Bootstrap = {
  base: string;
  screen: 'login' | 'dashboard' | 'share';
  share?: {
    kind: 'live' | 'recording';
    state: 'live' | 'ready' | 'ended' | 'unavailable';
    expires_at: string;
    media_url: string;
    frame_url?: string;
    status_url: string;
  };
  error: string;
  csrf: string;
};
export type Connection = {
  base_url: string;
  mcp_url: string;
  agent_instructions: string;
  agent_guide_url: string;
  mcp_config: {
    mcpServers: Record<string, { type: string; url: string; headers: { Authorization: string } }>;
  };
  tool_count: number;
  max_instances: number;
};
export type BrowserInstance = {
  instance_id: string;
  task_description?: string;
  status: string;
  owner: string;
  created_at: string;
  viewport: { width: number; height: number };
  user_agent: string;
  country?: string | null;
  country_source?: 'proxy_config' | 'unknown';
  locale: string;
  timezone: string;
  active_page_id?: string;
  proxy: { server: string; authenticated: boolean; proxy_id?: string } | null;
  egress?: {
    ip: string | null;
    source: 'unknown' | 'instance_check' | 'proxy_check';
    checked_at: string | null;
  };
  pages: { page_id: string; url: string }[];
};
export type Recording = {
  id: string;
  instance_id: string;
  task_description?: string;
  environment?: {
    captured_at: string;
    user_agent: string | null;
    os: string | null;
    country: string | null;
    country_source: 'proxy_config' | 'unknown';
    egress: NonNullable<BrowserInstance['egress']>;
  };
  owner: string;
  created_at: string;
  ended_at?: string;
  status: string;
  frames: number;
  fps: number;
  width: number;
  height: number;
  bytes: number;
  error?: string;
};
export type InstanceLogEvent = {
  seq: number;
  time: string;
  level: 'info' | 'warn' | 'error';
  component: string;
  code: string;
  page_id?: string;
  operation_id?: string;
  fields?: Record<string, string | number | boolean | null>;
  arguments?: Record<string, unknown>;
};
export type InstanceLogs = {
  instance: { instance_id: string; task_description?: string; status: string; ended_at?: string };
  entries: InstanceLogEvent[];
  next_after_seq: number;
  has_more: boolean;
  history_truncated: boolean;
  write_errors: number;
  dropped_events: number;
};
export type SavedProxy = {
  proxy_id: string;
  name: string;
  protocol: 'socks5' | 'http' | 'https';
  host: string;
  port: number;
  country: string;
  username: string;
  password: string;
  enabled: boolean;
  updated_at: string;
  status: 'healthy' | 'unhealthy' | 'unknown' | 'checking' | 'disabled';
  health: {
    status: 'healthy' | 'unhealthy' | 'unknown';
    checking: boolean;
    checked_at?: string;
    next_check_at?: string;
    latency_ms?: number;
    observed_ip?: string;
    http_status?: number;
    error_code?: string;
  };
};
export type ProxyMonitor = {
  running: boolean;
  interval_seconds: number;
  checking: number;
  queued: number;
};
export async function mutate<T>(
  path: string,
  method: 'POST' | 'PUT' | 'DELETE',
  data?: unknown,
): Promise<T> {
  const response = await fetch(bootstrap.base + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-csrf-token': bootstrap.csrf },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (response.status === 401) window.location.assign(bootstrap.base + '/');
  if (!response.ok) throw Error(`保存失败（${response.status}），请检查填写内容或重新登录`);
  return response.json() as Promise<T>;
}
export const bootstrap: Bootstrap = JSON.parse(document.getElementById('bootstrap')!.textContent!);
export async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(bootstrap.base + path, { cache: 'no-store', signal });
  if (response.status === 401) {
    window.location.assign(bootstrap.base + '/');
    throw Error('登录已过期，请重新登录');
  }
  if (!response.ok) throw Error(`暂时无法获取数据（${response.status}），请稍后刷新`);
  return response.json() as Promise<T>;
}
export async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const area = document.createElement('textarea');
    area.value = value;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    if (!copied) throw Error('浏览器不允许自动复制，请在详情中手动复制');
  }
}
export const compactId = (id: string) => id.replace(/^(ins_|rec_)/, '').slice(0, 8);
export const displayTime = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value));
export const fileSize = (bytes: number) =>
  bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : bytes >= 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${bytes} B`;
