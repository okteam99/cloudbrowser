import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { userAgentMetadata, clientHintHeaders } from '../src/user-agent.js';
import { BrowserManager } from '../src/browser.js';
import { config } from '../src/config.js';

const android =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.58 Mobile Safari/537.36';
const windows =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.87';
test('UA hints derive declared versions and avoid inventing absent device information', () => {
  const hints = userAgentMetadata({ userAgent: android })!;
  assert.deepEqual(hints.brands, [
    { brand: 'Chromium', version: '130' },
    { brand: 'Google Chrome', version: '130' },
  ]);
  assert.equal(hints.fullVersionList[1].version, '130.0.6723.58');
  assert.equal(hints.platform, 'Android');
  assert.equal(hints.platformVersion, '14');
  assert.equal(hints.model, 'Pixel 8');
  assert.equal(hints.mobile, true);
  assert.equal(hints.architecture, '');
  assert.equal(hints.bitness, '');
  const edge = userAgentMetadata({ userAgent: windows })!;
  assert.equal(edge.fullVersionList[1].brand, 'Microsoft Edge');
  assert.equal(edge.fullVersionList[1].version, '126.0.2592.87');
  assert.equal(edge.fullVersionList[0].version, '126.0.0.0');
  assert.equal(edge.platform, 'Windows');
  assert.equal(edge.platformVersion, '');
  assert.equal(edge.architecture, 'x86');
  assert.equal(edge.bitness, '64');
  assert.equal(edge.mobile, false);
  assert.equal(
    userAgentMetadata({ userAgent: android.replace('Pixel 8', 'Pixel 8 Build/AP1A; wv') })!.model,
    'Pixel 8',
  );
  assert.equal(userAgentMetadata({ userAgent: android.replace('Pixel 8', 'K') })!.model, '');
  for (const ua of [
    undefined,
    'CustomAgent/1.0',
    'Mozilla/5.0 Firefox/130.0',
    'Mozilla/5.0 (iPhone) CriOS/130.0 Mobile Safari/604.1',
  ])
    assert.equal(userAgentMetadata({ userAgent: ua }), undefined);
  assert.deepEqual(clientHintHeaders({ accept: 'text/html' }, android), { accept: 'text/html' });
  assert.deepEqual(
    clientHintHeaders({ 'sec-ch-ua': 'native', accept: 'text/html' }, 'CustomAgent/1.0'),
    { accept: 'text/html' },
  );
});

test(
  'native Chromium hints match UA in first headers, JS, popups, frames, workers and isolated instances',
  { timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-ua-ch-'));
    const requests: { url: string; headers: http.IncomingHttpHeaders }[] = [];
    const readIdentity = `async () => ({ua:navigator.userAgent,hints:navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(['fullVersionList','platformVersion','architecture','bitness','model','wow64','formFactors']) : null})`;
    let url = '',
      cross = '';
    const server = http.createServer((req, res) => {
      requests.push({ url: req.url!, headers: req.headers });
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: cross + '/redirected' });
        return res.end();
      }
      res.setHeader(
        'Accept-CH',
        'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Model, Sec-CH-UA-Arch, Sec-CH-UA-Bitness',
      );
      if (req.url === '/worker.js') {
        res.setHeader('Content-Type', 'text/javascript');
        return res.end(`(${readIdentity})().then(v=>postMessage(v));`);
      }
      if (req.url === '/ip') {
        res.setHeader('Content-Type', 'application/json');
        return res.end('{"ip":"127.0.0.1"}');
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        `<script>window.firstIdentity=(${readIdentity})();</script><title>Hints fixture</title>` +
          (req.url === '/main'
            ? `<iframe src="${url}/frame"></iframe><iframe src="${cross}/cross-frame"></iframe><a target="_blank" href="${url}/popup">Popup</a>`
            : ''),
      );
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as any).port;
    url = `http://127.0.0.1:${port}`;
    cross = `http://localhost:${port}`;
    const m = new BrowserManager({
      ...config(),
      dataDir: dir,
      allowPrivate: true,
      recordVideo: false,
    });
    await m.init();
    const call = (name: string, args: any) => m.execute('alice', name, args);
    const assertAndroid = (v: any) => {
      assert.equal(v.ua, android);
      assert.ok(v.hints, 'secure-context hints missing');
      assert.ok(v.hints.brands.some((x: any) => x.brand === 'Chromium' && x.version === '130'));
      assert.ok(
        v.hints.fullVersionList.some(
          (x: any) => x.brand === 'Chromium' && x.version === '130.0.6723.58',
        ),
      );
      assert.equal(v.hints.platform, 'Android');
      assert.equal(v.hints.platformVersion, '14');
      assert.equal(v.hints.model, 'Pixel 8');
      assert.equal(v.hints.mobile, true);
      assert.equal(v.hints.architecture, '');
      assert.equal(v.hints.bitness, '');
      assert.deepEqual(v.hints.formFactors, ['Mobile']);
    };
    try {
      const i = await call('create_instance', { user_agent: android, mobile: { enabled: true } });
      assert.equal(i.browser_version, m.instances.get(i.instance_id)!.browser.version());
      assert.equal(i.user_agent_metadata.fullVersion, '130.0.6723.58');
      const ids = { instance_id: i.instance_id, page_id: i.pages[0].page_id };
      await call('navigate', { ...ids, url: url + '/main' });
      const page = m.instances.get(i.instance_id)!.pages.get(ids.page_id)!.page;
      assertAndroid(await page.evaluate('window.firstIdentity'));
      await page.locator('iframe').first().waitFor();
      for (const frame of page.frames()) {
        await frame.waitForFunction('window.firstIdentity');
        assertAndroid(await frame.evaluate('window.firstIdentity'));
      }
      const popupPromise = page.waitForEvent('popup');
      await call('interact', { ...ids, action: 'click', target: { text: 'Popup' } });
      const popup = await popupPromise;
      await popup.waitForLoadState('domcontentloaded');
      assertAndroid(await popup.evaluate('window.firstIdentity'));
      const worker = await page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const w = new Worker('/worker.js');
            w.onmessage = (e) => {
              w.terminate();
              resolve(e.data);
            };
            w.onerror = (e) => {
              w.terminate();
              reject(new Error(e.message));
            };
          }),
      );
      assertAndroid(worker);
      const second = await call('create_page', {
        instance_id: i.instance_id,
        url: url + '/second',
      });
      assertAndroid(
        (
          await call('evaluate', {
            instance_id: i.instance_id,
            page_id: second.page_id,
            script: 'window.firstIdentity',
          })
        ).value,
      );
      await page.reload({ waitUntil: 'domcontentloaded' });
      assertAndroid(await page.evaluate('window.firstIdentity'));
      await page.evaluate('fetch("/echo")');
      for (const path of [
        '/main',
        '/frame',
        '/cross-frame',
        '/popup',
        '/second',
        '/worker.js',
        '/echo',
      ]) {
        const observed = requests.filter((r) => r.url === path);
        assert.ok(observed.length, path + ' request missing');
        for (const r of observed) {
          assert.equal(r.headers['user-agent'], android, path);
          // Chromium can omit UA-CH on the worker script fetch; worker JS is
          // asserted separately above. Do not inject hints when none were sent.
          if (path === '/worker.js' && r.headers['sec-ch-ua'] === undefined) {
            assert.equal(r.headers['sec-ch-ua-full-version-list'], undefined);
            continue;
          }
          assert.match(String(r.headers['sec-ch-ua']), /"Chromium";v="130"/, path);
          assert.equal(r.headers['sec-ch-ua-mobile'], '?1', path);
          assert.equal(r.headers['sec-ch-ua-platform'], '"Android"', path);
        }
      }
      assert.equal(
        requests.find((r) => r.url === '/main')!.headers['sec-ch-ua-full-version-list'],
        undefined,
      );
      const echo = requests.find((r) => r.url === '/echo')!.headers;
      assert.match(String(echo['sec-ch-ua-full-version-list']), /"Chromium";v="130.0.6723.58"/);
      assert.equal(echo['sec-ch-ua-model'], '"Pixel 8"');
      await m.instances
        .get(i.instance_id)!
        .context.addCookies([{ name: 'same_origin_only', value: 'fixture', url }]);
      await page.evaluate(
        'fetch("/redirect", {headers:{Authorization:"Bearer fixture-only"}}).catch(()=>{})',
      );
      const redirected = requests.find((r) => r.url === '/redirected')!.headers;
      assert.equal(redirected.authorization, undefined);
      assert.equal(redirected.cookie, undefined);
      if (redirected['sec-ch-ua'])
        assert.match(String(redirected['sec-ch-ua']), /"Chromium";v="130"/);
      const verified = await call('verify_environment', {
        instance_id: i.instance_id,
        check_url: url + '/ip',
      });
      assertAndroid({ ua: verified.actual.user_agent, hints: verified.actual.client_hints });
      const other = await call('create_instance', { user_agent: windows });
      const otherIds = { instance_id: other.instance_id, page_id: other.pages[0].page_id };
      await call('navigate', { ...otherIds, url: url + '/edge' });
      const edge = (await call('evaluate', { ...otherIds, script: 'window.firstIdentity' })).value;
      assert.equal(edge.hints.fullVersionList[1].version, '126.0.2592.87');
      assert.equal(edge.hints.platform, 'Windows');
      assertAndroid(await page.evaluate('window.firstIdentity'));
      const native = await call('create_instance', {});
      await call('navigate', {
        instance_id: native.instance_id,
        page_id: native.pages[0].page_id,
        url: url + '/native',
      });
      const nativeHeaders = requests.find((r) => r.url === '/native')!.headers;
      assert.match(
        String(nativeHeaders['sec-ch-ua']),
        new RegExp('"Chromium";v="' + native.browser_version.split('.')[0] + '"'),
      );
      assert.equal(native.user_agent_metadata, null);
      const custom = await call('create_instance', { user_agent: 'CustomAgent/1.0' });
      await call('navigate', {
        instance_id: custom.instance_id,
        page_id: custom.pages[0].page_id,
        url: url + '/opaque',
      });
      assert.equal(requests.find((r) => r.url === '/opaque')!.headers['sec-ch-ua'], undefined);
      const opaqueProfile = await call('create_instance', {
        user_agent: 'CustomAgent/1.0',
        device_profile_id: 'macos-arm-chrome155',
      });
      assert.equal(opaqueProfile.user_agent, 'CustomAgent/1.0');
      assert.equal(opaqueProfile.device_profile.client_hints, null);
      assert.equal(opaqueProfile.user_agent_metadata, null);
      const opaqueIds = {
        instance_id: opaqueProfile.instance_id,
        page_id: opaqueProfile.pages[0].page_id,
      };
      await call('navigate', { ...opaqueIds, url: url + '/opaque-profile' });
      const opaqueHeaders = requests.find((r) => r.url === '/opaque-profile')!.headers;
      assert.equal(opaqueHeaders['user-agent'], 'CustomAgent/1.0');
      assert.equal(opaqueHeaders['sec-ch-ua'], undefined);
      assert.deepEqual(
        (
          await call('evaluate', {
            ...opaqueIds,
            script: '({ua:navigator.userAgent,platform:navigator.platform,width:screen.width})',
          })
        ).value,
        { ua: 'CustomAgent/1.0', platform: 'MacIntel', width: 1920 },
      );
      await call('close_instance', { instance_id: i.instance_id });
      const history = await call('inspect_instance', { instance_id: i.instance_id, probe: false });
      assert.equal(history.instance.environment.browser_version, i.browser_version);
      assert.equal(history.instance.environment.user_agent_metadata.fullVersion, '130.0.6723.58');
    } finally {
      await m.shutdown();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
