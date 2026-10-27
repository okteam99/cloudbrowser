import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import type { Config } from './config.js';

export const fingerprintAcceptCH = [
  'Sec-CH-UA-Full-Version-List',
  'Sec-CH-UA-Platform-Version',
  'Sec-CH-UA-Arch',
  'Sec-CH-UA-Bitness',
  'Sec-CH-UA-Model',
  'Sec-CH-UA-WoW64',
  'Sec-CH-UA-Form-Factors',
].join(', ');

// Only the visitor's selected request metadata is public. Never reflect cookies,
// Authorization, query strings, arbitrary forwarded headers or deployment state.
export function fingerprintRequest(
  req: IncomingMessage,
  cfg: Pick<Config, 'quickTunnel' | 'cfTunnelToken'>,
) {
  const peer = req.socket.remoteAddress ?? '';
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer);
  const cf = req.headers['cf-connecting-ip'];
  const forwarded = Boolean(
    (cfg.quickTunnel || cfg.cfTunnelToken) && loopback && typeof cf === 'string' && isIP(cf),
  );
  const headers: Record<string, string> = {};
  for (const name of [
    'user-agent',
    'accept-language',
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform',
    'sec-ch-ua-full-version-list',
    'sec-ch-ua-platform-version',
    'sec-ch-ua-arch',
    'sec-ch-ua-bitness',
    'sec-ch-ua-model',
    'sec-ch-ua-wow64',
    'sec-ch-ua-form-factors',
    'dnt',
    'sec-gpc',
  ]) {
    const value = req.headers[name];
    if (typeof value === 'string') headers[name] = value.slice(0, 4096);
  }
  return {
    observed_at: new Date().toISOString(),
    ip: forwarded ? cf : peer.replace(/^::ffff:/, ''),
    ip_source: forwarded ? 'cloudflare_tunnel_header' : 'socket_peer',
    ip_note: forwarded
      ? '来自本机 Cloudflare 隧道转发的 CF-Connecting-IP；依赖部署边界信任。'
      : '当前 HTTP 连接的对端；其他反向代理场景可能是代理地址。',
    headers,
  };
}
