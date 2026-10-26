import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserManager } from '../src/browser.js';
import { config } from '../src/config.js';

test(
  'navigation history preserves redirect URLs, native-app targets, no-content responses, downloads and closed-instance ownership',
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-navigation-'));
    const intent =
      'intent://launch/#Intent;scheme=fixture;package=com.example.fixture;S.browser_fallback_url=market%3A%2F%2Fdetails%3Fid%3Dcom.example.fixture;end';
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith('/start')) {
        res.writeHead(302, { Location: '/middle?token=retained' });
        res.end();
      } else if (req.url?.startsWith('/middle')) {
        res.writeHead(307, { Location: '/landing?final=ok' });
        res.end();
      } else if (req.url === '/app') {
        res.writeHead(302, { Location: intent });
        res.end();
      } else if (req.url === '/empty') {
        res.writeHead(204);
        res.end();
      } else if (req.url === '/download') {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="fixture.txt"',
        });
        res.end('download fixture');
      } else if (req.url === '/popup') {
        res.writeHead(302, { Location: '/landing?popup=1' });
        res.end();
      } else {
        res.setHeader('Content-Type', 'text/html');
        res.end(
          '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Landing</title><h1>Ready</h1><a target="_blank" href="/popup">Popup</a>',
        );
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const cfg = { ...config(), dataDir: dir, recordVideo: false, allowPrivate: true };
    const manager = new BrowserManager(cfg);
    await manager.init();
    const call = (name: string, args: any = {}) => manager.execute('alice', name, args);
    try {
      const created = await call('create_instance', {
        device_profile_id: 'android-pixel8-chrome155',
      });
      const ids = { instance_id: created.instance_id, page_id: created.pages[0].page_id };
      const history = () => call('list_navigation_events', { ...ids, limit: 200 });
      await call('navigate', { ...ids, url: base + '/start?first=1' });
      let events = await history();
      assert.equal(events.recorded, true);
      const redirects = events.entries.filter((e: any) => e.kind === 'redirect');
      assert.deepEqual(
        redirects.map((e: any) => [e.url, e.status, e.to_url]),
        [
          [base + '/start?first=1', 302, base + '/middle?token=retained'],
          [base + '/middle?token=retained', 307, base + '/landing?final=ok'],
        ],
      );
      assert.equal(new Set(redirects.map((e: any) => e.navigation_id)).size, 1);
      assert.ok(
        events.entries.some(
          (e: any) => e.kind === 'loaded' && e.url === base + '/landing?final=ok',
        ),
      );
      await call('evaluate', { ...ids, script: 'history.pushState({}, "", "#section")' });
      assert.ok(
        (await history()).entries.some(
          (e: any) => e.kind === 'same_document' && e.url.endsWith('#section'),
        ),
      );
      assert.equal(
        (await call('evaluate', { ...ids, script: 'navigator.platform' })).value,
        'Linux armv81',
      );
      const page = manager.instances.get(ids.instance_id)!.pages.get(ids.page_id)!.page;
      const popupEvent = page.waitForEvent('popup');
      await call('interact', { ...ids, action: 'click', target: { text: 'Popup' } });
      await popupEvent;
      const popup = (await call('list_pages', { instance_id: ids.instance_id })).find(
        (p: any) => p.page_id !== ids.page_id,
      );
      await call('close_page', { instance_id: ids.instance_id, page_id: popup.page_id });
      const popupHistory = await call('list_navigation_events', {
        instance_id: ids.instance_id,
        page_id: popup.page_id,
      });
      assert.ok(
        popupHistory.entries.some(
          (e: any) => e.kind === 'redirect' && e.to_url === base + '/landing?popup=1',
        ),
        JSON.stringify({
          popup,
          popupHistory,
          all: await call('list_navigation_events', { instance_id: ids.instance_id, limit: 200 }),
        }),
      );

      await assert.rejects(call('navigate', { ...ids, url: base + '/app' }), {
        code: 'EXTERNAL_PROTOCOL',
      });
      events = await history();
      assert.ok(
        events.entries.some(
          (e: any) =>
            e.kind === 'redirect' &&
            e.url === base + '/app' &&
            e.status === 302 &&
            e.to_url === intent,
        ),
      );
      assert.ok(
        events.entries.some((e: any) => e.kind === 'external_protocol' && e.url === intent),
      );
      const logs = await call('get_logs', {
        instance_id: ids.instance_id,
        component: 'operation',
        limit: 200,
      });
      assert.ok(
        logs.entries.some(
          (e: any) =>
            e.code === 'operation_failed' &&
            e.fields.error_code === 'EXTERNAL_PROTOCOL' &&
            e.fields.error_message.includes('net::ERR_ABORTED'),
        ),
      );
      await assert.rejects(call('navigate', { ...ids, url: base + '/empty' }), {
        code: 'NAVIGATION_ABORTED',
      });
      assert.ok(
        (await history()).entries.some((e: any) => e.url === base + '/empty' && e.status === 204),
      );
      await assert.rejects(call('navigate', { ...ids, url: base + '/download' }), {
        code: 'NAVIGATION_DOWNLOAD',
      });
      for (let n = 0; n < 50; n++) {
        if (
          (await call('list_downloads', { instance_id: ids.instance_id }))[0]?.status ===
          'completed'
        )
          break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(
        (await history()).entries.some(
          (e: any) => e.kind === 'download' && e.filename === 'fixture.txt',
        ),
      );
      await call('close_instance', { instance_id: ids.instance_id });
      const saved = await history();
      assert.ok(saved.entries.length > 8);
      const first = await call('list_navigation_events', { ...ids, limit: 2 });
      assert.equal(first.has_more, true);
      const next = await call('list_navigation_events', {
        ...ids,
        limit: 2,
        after_seq: first.next_after_seq,
      });
      assert.ok(next.entries[0].seq > first.entries.at(-1).seq);
      await assert.rejects(manager.execute('bob', 'list_navigation_events', ids), {
        code: 'INSTANCE_NOT_FOUND',
      });
      await manager.shutdown();
      const restarted = new BrowserManager(cfg);
      await restarted.init();
      try {
        const restored = await restarted.execute('alice', 'list_navigation_events', {
          ...ids,
          limit: 200,
        });
        assert.deepEqual(restored.entries, saved.entries);
        restarted.logs.register({
          instance_id: 'ins_00000000-0000-4000-8000-000000000001',
          owner: 'alice',
          status: 'closed',
          created_at: new Date().toISOString(),
        });
        const legacy = await restarted.execute('alice', 'list_navigation_events', {
          instance_id: 'ins_00000000-0000-4000-8000-000000000001',
        });
        assert.equal(legacy.recorded, false);
      } finally {
        await restarted.shutdown();
      }
    } finally {
      await manager.shutdown();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
