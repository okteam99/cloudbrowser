export type TunnelDiagnostic = {
  level: 'info' | 'warn' | 'error';
  code: string;
  fields: Record<string, string | number>;
};

// Keep transport evidence without copying credentials, request headers or the
// connector's entire remotely managed configuration into diagnostic responses.
export function parseTunnelDiagnostic(line: string): TunnelDiagnostic | undefined {
  const header = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+(INF|WRN|ERR)\s+/.exec(line);
  if (!header) return;
  const fields: TunnelDiagnostic['fields'] = { source_time: header[1] };
  for (const [name, key] of [
    ['connIndex', 'connection_index'],
    ['ingressRule', 'ingress_rule'],
  ] as const) {
    const match = new RegExp(`\\b${name}=(\\d{1,5})\\b`).exec(line);
    if (match) fields[key] = Number(match[1]);
  }
  if (line.includes('Registered tunnel connection')) {
    const location = /\blocation=([a-z0-9-]{1,32})\b/.exec(line);
    if (location) fields.location = location[1];
    return { level: 'info', code: 'tunnel_connection_registered', fields };
  }
  if (header[2] !== 'ERR' && header[2] !== 'WRN') return;
  // cloudflared emits a second summary for the same failed request.
  if (line.includes('failed to serve incoming request')) return;
  fields.reason = /connection reset by peer|ECONNRESET/i.test(line)
    ? 'connection_reset'
    : /connection refused/i.test(line)
      ? 'connection_refused'
      : /timeout|timed out|deadline exceeded/i.test(line)
        ? 'timeout'
        : /\bEOF\b/.test(line)
          ? 'eof'
          : /x509|certificate|tls/i.test(line)
            ? 'tls'
            : 'other';
  const origin = /\boriginService=("[^"]*"|\S+)/.exec(line);
  if (origin) {
    try {
      fields.origin = new URL(origin[1].replace(/^"|"$/g, '')).origin;
    } catch {}
  }
  return {
    level: header[2] === 'ERR' ? 'error' : 'warn',
    code: line.includes('Unable to reach the origin service')
      ? 'tunnel_origin_error'
      : 'tunnel_connection_warning',
    fields,
  };
}

export function tunnelDiagnosticReader(report?: (event: TunnelDiagnostic) => void) {
  const pending = { stdout: '', stderr: '' };
  return (chunk: Buffer, stream: 'stdout' | 'stderr') => {
    if (!report) return;
    const lines = (pending[stream] + chunk.toString()).split('\n');
    pending[stream] = lines.pop()!.slice(-8192);
    for (const line of lines) {
      if (line.length > 8192) continue;
      const event = parseTunnelDiagnostic(line);
      if (event) {
        try {
          report(event);
        } catch {
          /* Diagnostics must not interrupt the connector. */
        }
      }
    }
  };
}
