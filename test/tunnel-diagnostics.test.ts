import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTunnelDiagnostic,
  tunnelDiagnosticReader,
  type TunnelDiagnostic,
} from '../src/tunnel-diagnostics.js';

test('tunnel log framing classifies failures without retaining tokens, credentials or configuration', () => {
  const origin =
    '2026-10-25T12:21:50Z ERR error="Unable to reach the origin service: connection reset by peer" connIndex=3 ingressRule=1 originService=http://user:secret@localhost:8080/private?token=hidden';
  const entries: TunnelDiagnostic[] = [];
  const read = tunnelDiagnosticReader((e) => entries.push(e));
  read(Buffer.from(origin.slice(0, 45)), 'stderr');
  read(
    Buffer.from('2026-10-25T12:00:00Z INF Updated to new configuration secret=private\n'),
    'stdout',
  );
  read(Buffer.from(origin.slice(45) + '\n'), 'stderr');
  read(
    Buffer.from(
      '2026-10-25T12:21:50Z ERR failed to serve incoming request error="Failed to proxy HTTP: Unable to reach the origin service"\n',
    ),
    'stderr',
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].fields.reason, 'connection_reset');
  assert.equal(entries[0].fields.origin, 'http://localhost:8080');
  assert.ok(!/secret|hidden|private|user/.test(JSON.stringify(entries)));
  for (const [message, reason] of [
    ['dial tcp: connection refused', 'connection_refused'],
    ['i/o timeout', 'timeout'],
    ['unexpected EOF', 'eof'],
    ['x509 certificate expired', 'tls'],
  ]) {
    assert.equal(
      parseTunnelDiagnostic(`2026-10-25T12:21:50Z ERR error="${message}"`)?.fields.reason,
      reason,
    );
  }
  const connected = parseTunnelDiagnostic(
    '2026-10-25T12:22:00Z INF Registered tunnel connection connIndex=1 location=sin12 protocol=http2',
  );
  assert.equal(connected?.code, 'tunnel_connection_registered');
  assert.equal(connected?.fields.location, 'sin12');
  assert.equal(parseTunnelDiagnostic('unstructured credentials=private'), undefined);
  const brokenObserver = tunnelDiagnosticReader(() => {
    throw Error('fixture');
  });
  assert.doesNotThrow(() => brokenObserver(Buffer.from(origin + '\n'), 'stderr'));
});
