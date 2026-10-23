import type { InstanceOptions } from './config.js';

export type InstanceProperties = {
  viewport: { width: number; height: number };
  locale: string;
  timezone: string;
  mobile?: InstanceOptions['mobile'];
  proxy: { server: string; proxy_id?: string; authenticated: boolean } | null;
  idle_timeout_seconds: number;
  max_lifetime_seconds: number;
};
export type InstancePage = {
  page_id: string;
  url: string;
  title: string;
  state: string;
  active: boolean;
};
export function instanceDetailsUrl(base: string | undefined, id: string) {
  return base ? `${base.replace(/\/$/, '')}/instances/${id}?access_token=` : undefined;
}
// Only a local, exact instance path can be used after login; never accept arbitrary redirects.
export function instanceLoginTarget(raw: string | null, prefix: string) {
  const start = `${prefix}/instances/`;
  if (!raw?.startsWith(start) || !/^ins_[a-f0-9-]{36}$/.test(raw.slice(start.length)))
    return undefined;
  return raw;
}
