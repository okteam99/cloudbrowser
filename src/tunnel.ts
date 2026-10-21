import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './config.js';

export function validateTunnelConfig(cfg: Config) {
  if (!cfg.quickTunnel && !cfg.cfTunnelToken) return;
  if (cfg.quickTunnel && cfg.cfTunnelToken)
    throw Error('CF_QUICK_TUNNEL and CF_TUNNEL_TOKEN are mutually exclusive.');
  if (!cfg.webPort || !cfg.webPassword)
    throw Error('Cloudflare Tunnel requires WEB_PORT > 0 and WEB_PASSWORD.');
  if (cfg.quickTunnel && cfg.baseUrl)
    throw Error('Use either CF_QUICK_TUNNEL=true or BASE_URL, not both.');
  if (cfg.cfTunnelToken && cfg.baseUrl) {
    let base: URL;
    try {
      base = new URL(cfg.baseUrl);
    } catch {
      throw Error('Named Cloudflare Tunnel requires an HTTPS BASE_URL.');
    }
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
      throw Error(
        'Named Cloudflare Tunnel requires an HTTPS BASE_URL without credentials, query or fragment.',
      );
  }
}

export function inferTunnelUrl(config: unknown, port: number) {
  const hosts = new Set<string>();
  const rules = (config as any)?.ingress;
  if (Array.isArray(rules))
    for (const rule of rules) {
      try {
        if (
          rule.path ||
          typeof rule.hostname !== 'string' ||
          !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(rule.hostname)
        )
          continue;
        const service = new URL(rule.service);
        if (
          service.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(service.hostname) &&
          Number(service.port || 80) === port &&
          !service.username &&
          !service.password &&
          service.pathname === '/' &&
          !service.search &&
          !service.hash
        )
          hosts.add(`https://${rule.hostname.toLowerCase()}`);
      } catch {
        /* Non-HTTP catch-all rules are not application routes. */
      }
    }
  if (hosts.size === 0)
    throw Error(
      'Cannot identify a public hostname targeting this container. Configure a hostname pointing to http://localhost:' +
        port +
        ', or set BASE_URL explicitly.',
    );
  return [...hosts][0];
}

export async function startCloudflareTunnel(cfg: Config, signal?: AbortSignal) {
  validateTunnelConfig(cfg);
  const dir = await mkdtemp(join(tmpdir(), 'browser-mcp-tunnel-'));
  const file = join(dir, 'config.yml');
  await writeFile(file, '{}\n', { mode: 0o600 });
  // Isolate host tunnel configuration. Pass the connector token through its environment, never argv or logs.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('TUNNEL_')),
  );
  env.HOME = dir;
  if (cfg.cfTunnelToken) env.TUNNEL_TOKEN = cfg.cfTunnelToken;
  const child = spawn(
    cfg.cloudflared,
    [
      'tunnel',
      '--config',
      file,
      '--no-autoupdate',
      '--protocol',
      'http2',
      '--metrics',
      '127.0.0.1:0',
      ...(cfg.cfTunnelToken ? ['run'] : ['--url', `http://127.0.0.1:${cfg.webPort}`]),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env },
  );
  let stopped = false;
  const exited = new Promise<void>((resolve) =>
    child.once('close', () => {
      stopped = true;
      resolve();
    }),
  );
  const kill = () => {
    if (!stopped) child.kill('SIGTERM');
  };
  const close = async () => {
    kill();
    const force = setTimeout(() => {
      if (!stopped) child.kill('SIGKILL');
    }, 2000);
    force.unref();
    await exited;
    clearTimeout(force);
    await rm(dir, { recursive: true, force: true });
  };
  process.once('exit', kill);
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let text = '',
        metrics = '',
        polling = false,
        settled = false;
      const aborter = new AbortController();
      const cleanup = () => {
        settled = true;
        clearTimeout(timeout);
        clearInterval(interval);
        aborter.abort();
        child.off('error', error);
        child.off('close', end);
        signal?.removeEventListener('abort', abort);
      };
      const fail = (message: string) => {
        if (!settled) {
          cleanup();
          reject(Error(message));
        }
      };
      const error = () => fail('Unable to start cloudflared. Check CLOUDFLARED_PATH.');
      const end = () =>
        fail(
          'Cloudflare Tunnel exited before becoming ready. Check the connector token and outbound connectivity.',
        );
      const abort = () => fail('Cloudflare Tunnel startup cancelled.');
      const poll = async () => {
        if (!metrics || polling || settled) return;
        polling = true;
        try {
          const init = { signal: AbortSignal.any([aborter.signal, AbortSignal.timeout(1500)]) };
          if (!(await fetch(metrics + '/ready', init)).ok) return;
          let address = cfg.baseUrl;
          if (!address && cfg.cfTunnelToken) {
            const response = await fetch(metrics + '/config', init);
            if (!response.ok) return;
            const data: any = await response.json();
            if (data.version < 0) return;
            try {
              address = inferTunnelUrl(data.config, cfg.webPort);
            } catch (e) {
              fail((e as Error).message);
              return;
            }
          } else if (!address) {
            const response = await fetch(metrics + '/quicktunnel', init);
            if (!response.ok) return;
            const data: any = await response.json();
            if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(data.hostname)) return;
            address = `https://${data.hostname}`;
          }
          if (address && !settled) {
            cleanup();
            resolve(address);
          }
        } catch {
          /* The loopback readiness endpoint can appear before the connection is established. */
        } finally {
          polling = false;
        }
      };
      const timeout = setTimeout(
        () =>
          fail(
            'Cloudflare Tunnel startup timed out. Check outbound HTTPS/TCP 7844 connectivity and tunnel configuration.',
          ),
        cfg.tunnelStartupTimeout,
      );
      const interval = setInterval(() => void poll(), 200);
      const read = (chunk: Buffer) => {
        text = (text + chunk.toString()).slice(-16384);
        const match = /Starting metrics server on (127\.0\.0\.1:\d+)\/metrics/.exec(text);
        if (match && Number(match[1].split(':')[1]) > 0) {
          metrics = 'http://' + match[1];
          void poll();
        }
      };
      child.once('error', error);
      child.once('close', end);
      child.stdout.on('data', read);
      child.stderr.on('data', read);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    if (stopped || signal?.aborted) throw Error('Cloudflare Tunnel is no longer running.');
    return {
      url,
      exited,
      close: async () => {
        process.removeListener('exit', kill);
        await close();
      },
    };
  } catch (error) {
    process.removeListener('exit', kill);
    await close();
    throw error;
  }
}
