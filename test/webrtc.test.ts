import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { BrowserManager } from '../src/browser.js';
import { config } from '../src/config.js';
import { socksFixture } from './socks-fixture.js';

// A local STUN endpoint is an independent network observer. A cosmetic change to
// candidates/SDP cannot pass this test if Chromium still sends unproxied UDP.
test(
  'full Chromium blocks direct WebRTC STUN traffic in proxied pages, frames, popups and reloads',
  { timeout: 45000 },
  async () => {
    const stun = dgram.createSocket('udp4');
    let packets = 0,
      proxied = 0;
    stun.on('message', (msg, peer) => {
      if (msg.length < 20 || msg.readUInt16BE(0) !== 1 || msg.readUInt32BE(4) !== 0x2112a442)
        return;
      packets++;
      const out = Buffer.alloc(32);
      out.writeUInt16BE(0x101, 0);
      out.writeUInt16BE(12, 2);
      msg.copy(out, 4, 4, 20);
      out.writeUInt16BE(0x20, 20); // XOR-MAPPED-ADDRESS
      out.writeUInt16BE(8, 22);
      out[25] = 1;
      out.writeUInt16BE(peer.port ^ 0x2112, 26);
      [203, 0, 113, 77].forEach((byte, n) => {
        out[28 + n] = byte ^ msg[4 + n];
      });
      stun.send(out, peer.port, peer.address);
    });
    await new Promise<void>((r) => stun.bind(0, '0.0.0.0', r));
    const stunUrl = `stun:127.0.0.1:${stun.address().port}`;
    const probe = async (url: string) => {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: url }] });
      const candidates: string[] = [];
      pc.onicecandidate = (e) => {
        if (e.candidate) candidates.push(e.candidate.candidate);
      };
      pc.createDataChannel('network-probe');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await pc.setLocalDescription(await pc.createOffer());
        await new Promise<void>((resolve) => {
          pc.onicegatheringstatechange = () => {
            if (pc.iceGatheringState === 'complete') resolve();
          };
          if (pc.iceGatheringState === 'complete') resolve();
          else timer = setTimeout(resolve, 4000);
        });
        return { state: pc.iceGatheringState, candidates };
      } finally {
        clearTimeout(timer);
        pc.close();
      }
    };
    // Strip tsx's function-name helper via an explicit lexical argument, as in
    // the production device probe. No page API is replaced.
    const script = `((__name) => (${probe.toString()})(${JSON.stringify(stunUrl)}))((v) => v)`;
    let base = '';
    const fixture = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(
        `<script>window.iceProbe=${script}</script>` +
          (req.url === '/main'
            ? `<iframe src="${base.replace('127.0.0.1', 'localhost')}/frame"></iframe><a target="_blank" href="/popup">Popup</a>`
            : ''),
      );
    });
    await new Promise<void>((r) => fixture.listen(0, r));
    base = `http://127.0.0.1:${(fixture.address() as any).port}`;
    const socks = socksFixture(() => {
      proxied++;
    });
    await new Promise<void>((r) => socks.server.listen(0, '127.0.0.1', r));
    const dir = await mkdtemp(join(tmpdir(), 'cb-webrtc-'));
    const manager = new BrowserManager({
      ...config(),
      dataDir: dir,
      recordVideo: false,
      allowPrivate: true,
    });
    await manager.init();
    try {
      // Positive control: the old shell-only flag does not configure full Chrome.
      const control = await chromium.launch({
        channel: 'chromium',
        headless: true,
        proxy: { server: 'http://127.0.0.1:9' },
        args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      });
      try {
        const p = await control.newPage();
        const observed = await p.evaluate(script);
        assert.ok(
          packets > 0,
          'STUN fixture must observe real UDP before trusting the regression test',
        );
        assert.ok(
          observed.candidates.some(
            (c: string) => c.includes('203.0.113.77') && c.includes('typ srflx'),
          ),
        );
      } finally {
        await control.close();
      }
      packets = 0;
      const i = await manager.execute('qa', 'create_instance', {
        proxy: {
          server: `socks5://127.0.0.1:${(socks.server.address() as any).port}`,
          username: 'user',
          password: 'pass',
        },
      });
      const p = manager.instances.get(i.instance_id)!.pages.values().next().value!.page;
      const check = async (page: typeof p | ReturnType<typeof p.mainFrame>) => {
        await page.waitForFunction('window.iceProbe');
        const result = await page.evaluate('window.iceProbe');
        assert.equal(result.state, 'complete');
        assert.deepEqual(
          result.candidates,
          [],
          'HTTP CONNECT cannot proxy STUN UDP; do not expose host/srflx candidates',
        );
        assert.equal(packets, 0, 'WebRTC bypassed the proxy and contacted STUN directly');
      };
      await p.goto(base + '/main');
      for (const frame of p.frames()) await check(frame);
      const popupPromise = p.waitForEvent('popup');
      await p.getByText('Popup', { exact: true }).click();
      const popup = await popupPromise;
      await popup.waitForLoadState();
      await check(popup);
      await p.reload();
      await check(p);
      assert.ok(
        proxied >= 3,
        'Normal page requests must still reach the authenticated SOCKS5 upstream',
      );
    } finally {
      await manager.shutdown();
      socks.close();
      stun.close();
      await new Promise<void>((r) => fixture.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
