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
  instance_id?: string;
  return_to?: string;
  access_token?: string;
};
export type Connection = {
  base_url: string;
  mcp_url: string;
  api_base_url: string;
  openapi_url: string;
  api_instructions: string;
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
  details_url?: string;
  task_description?: string;
  status: string;
  owner: string;
  created_at: string;
  viewport: { width: number; height: number };
  user_agent: string;
  browser_version?: string;
  browser_mode?: string;
  device_profile?: DeviceProfileView | null;
  device_verification?: DeviceVerificationView | null;
  country?: string | null;
  country_source?: 'proxy_config' | 'unknown';
  locale: string;
  timezone: string;
  mobile?: { enabled: boolean; touch: boolean; device_scale_factor: number };
  idle_timeout_seconds?: number;
  max_lifetime_seconds?: number;
  busy?: boolean;
  active_operation?: { tool: string; started_at: string } | null;
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
    browser_version?: string;
    browser_mode?: string;
    device_profile?: DeviceProfileView | null;
    device_verification?: DeviceVerificationView | null;
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
  details_url?: string;
};
export type DeviceProfileView = { name: string; [key: string]: unknown };
export type DeviceVerificationView = {
  checked_at: string;
  page_id: string;
  url: string;
  profile_name: string | null;
  browser_version: string;
  fields: {
    scope: string;
    field: string;
    expected: unknown;
    actual: unknown;
    status: string;
    mode: string;
  }[];
  capabilities: {
    name: string;
    method: string;
    status: string;
    details: Record<string, unknown>;
  }[];
  summary: {
    matched: number;
    mismatched: number;
    unavailable: number;
    execution_passed: number;
    execution_failed: number;
  };
  notes: string[];
};
export type InstanceDetails = {
  details_url?: string;
  instance: {
    instance_id: string;
    task_description?: string;
    status: string;
    created_at?: string;
    updated_at?: string;
    ended_at?: string;
    close_reason?: string;
    environment?: Recording['environment'];
    properties?: Pick<
      BrowserInstance,
      | 'viewport'
      | 'locale'
      | 'timezone'
      | 'mobile'
      | 'proxy'
      | 'idle_timeout_seconds'
      | 'max_lifetime_seconds'
    >;
    exit_code?: number | null;
    exit_signal?: string | null;
  };
  current: BrowserInstance | null;
  pages: { page_id: string; url: string; title: string; state: string; active: boolean }[];
  recordings: Recording[];
  logs_available: boolean;
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
  if (response.status === 401) window.location.assign(loginPath());
  if (!response.ok) throw Error(`保存失败（${response.status}），请检查填写内容或重新登录`);
  return response.json() as Promise<T>;
}
export const bootstrap: Bootstrap = JSON.parse(document.getElementById('bootstrap')!.textContent!);
function loginPath() {
  return bootstrap.instance_id
    ? `${bootstrap.base}/instances/${bootstrap.instance_id}`
    : bootstrap.base + '/';
}
export class ApiError extends Error {
  constructor(public status: number) {
    super(`暂时无法获取数据（${status}），请稍后刷新`);
  }
}
export async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(bootstrap.base + path, {
    cache: 'no-store',
    signal,
    headers: bootstrap.access_token
      ? { Authorization: `Bearer ${bootstrap.access_token}` }
      : undefined,
  });
  if (response.status === 401) {
    window.location.assign(loginPath());
    throw Error('登录已过期，请重新登录');
  }
  if (!response.ok) throw new ApiError(response.status);
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
export const instancePath = (id: string) => `${bootstrap.base}/instances/${id}?access_token=`;
export function privateMediaUrl(path: string) {
  if (!bootstrap.access_token) return path;
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin) throw Error('Invalid media origin');
  url.searchParams.set('access_token', bootstrap.access_token);
  return url.pathname + url.search;
}
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
