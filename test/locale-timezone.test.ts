import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserManager } from '../src/browser.js';
import { config, createSchema } from '../src/config.js';

test('locale and timezone omission survives validation while invalid explicit values are rejected', () => {
  const args = createSchema.parse({ device_profile_id: 'iphone-standard' });
  assert.equal(Object.hasOwn(args, 'locale'), false);
  assert.equal(Object.hasOwn(args, 'timezone'), false);
  assert.equal(createSchema.safeParse({ locale: 'not_a_locale' }).success, false);
  assert.equal(createSchema.safeParse({ timezone: 'Not/A_Timezone' }).success, false);
});

test('explicit locale/timezone survive profile selection across page, Worker, HTTP and history without changing the template', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cb-locale-override-'));
  const server = http.createServer((req, res) => {
    res.setHeader(
      'content-type',
      req.url === '/worker.js'
        ? 'text/javascript'
        : req.url === '/echo'
          ? 'application/json'
          : 'text/html',
    );
    if (req.url === '/worker.js')
      res.end(
        "Promise.all([fetch('/echo').then(r=>r.json()),Promise.resolve({language:navigator.language,languages:[...navigator.languages],ua:navigator.userAgent,uaData:navigator.userAgentData?.toJSON(),locale:Intl.DateTimeFormat().resolvedOptions().locale,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone})]).then(([headers,identity])=>postMessage({headers,...identity}))",
      );
    else if (req.url === '/echo')
      res.end(
        JSON.stringify({
          language: req.headers['accept-language'],
          ua: req.headers['user-agent'],
          hints: req.headers['sec-ch-ua'],
        }),
      );
    else
      res.end(
        '<meta name="viewport" content="width=device-width,initial-scale=1"><h1>locale fixture</h1>',
      );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const manager = new BrowserManager({
    ...config(),
    dataDir: dir,
    recordVideo: false,
    allowPrivate: true,
  });
  await manager.init();
  try {
    const template = manager.deviceProfiles.get('macos-standard').profile;
    for (const mode of ['explicit', 'ua_default', 'inline', 'none']) {
      const raw = {
        locale: 'pt-BR',
        timezone: 'America/Sao_Paulo',
        ...(mode === 'explicit'
          ? { device_profile_id: 'macos-standard' }
          : mode === 'ua_default'
            ? { user_agent: template.user_agent }
            : mode === 'inline'
              ? { device_profile: template }
              : {}),
      };
      // The daemon and BrowserManager both validate arguments; absence must survive parsing.
      const instance = await manager.execute('qa', 'create_instance', createSchema.parse(raw));
      assert.equal(instance.locale, raw.locale, mode);
      assert.equal(instance.timezone, raw.timezone, mode);
      assert.deepEqual(instance.configuration_sources, {
        locale: 'request',
        timezone: 'request',
        languages: 'request_locale',
      });
      assert.equal(instance.locale_observation.language, 'pt-BR');
      assert.equal(instance.locale_observation.timezone, 'America/Sao_Paulo');
      const ids = { instance_id: instance.instance_id, page_id: instance.pages[0].page_id };
      await manager.execute('qa', 'navigate', { ...ids, url: base });
      const page = manager.instances.get(instance.instance_id)!.pages.get(ids.page_id)!.page;
      const observed = await page.evaluate(async () => ({
        language: navigator.language,
        languages: [...navigator.languages],
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        offset: new Date('2026-01-15T12:00:00Z').getTimezoneOffset(),
        headers: await (await fetch('/echo')).json(),
      }));
      assert.equal(observed.language, 'pt-BR');
      assert.deepEqual(observed.languages, ['pt-BR']);
      assert.equal(observed.locale, 'pt-BR');
      assert.equal(observed.timezone, 'America/Sao_Paulo');
      assert.equal(observed.offset, 180);
      assert.equal(observed.headers.language, 'pt-BR');
      const worker: any = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const w = new Worker('/worker.js');
            w.onmessage = (e) => {
              w.terminate();
              resolve(e.data);
            };
          }),
      );
      assert.equal(worker.language, 'pt-BR', mode);
      assert.deepEqual(worker.languages, ['pt-BR'], mode);
      assert.equal(worker.locale, 'pt-BR', mode);
      assert.equal(worker.timezone, 'America/Sao_Paulo', mode);
      assert.equal(worker.headers.language, 'pt-BR', mode);
      if (mode === 'none') {
        assert.ok(
          worker.uaData?.brands?.length,
          'Native Worker Client Hints must remain available',
        );
        assert.equal(worker.ua, observed.headers.ua);
      }
      await manager.execute('qa', 'close_instance', { instance_id: instance.instance_id });
      const history = await manager.execute('qa', 'get_instance_details', {
        instance_id: instance.instance_id,
      });
      assert.equal(history.instance.properties.locale, 'pt-BR');
      assert.equal(history.instance.properties.timezone, 'America/Sao_Paulo');
      assert.equal(history.instance.properties.configuration_sources.timezone, 'request');
      assert.equal(history.instance.properties.locale_observation.language, 'pt-BR');
      if (mode !== 'none') {
        assert.equal(history.instance.environment.device_profile.locale, 'pt-BR');
        assert.deepEqual(history.instance.environment.device_profile.languages, ['pt-BR']);
      }
      assert.deepEqual(manager.deviceProfiles.get('macos-standard').profile, template);
    }
    const omitted = await manager.execute(
      'qa',
      'create_instance',
      createSchema.parse({ device_profile_id: 'iphone-standard' }),
    );
    assert.equal(omitted.locale, 'en-SG');
    assert.equal(omitted.timezone, 'Asia/Singapore');
    assert.deepEqual(omitted.device_profile.languages, ['en-SG']);
    assert.equal(omitted.device_profile.http_accept_language, 'en-SG,en-GB;q=0.9,en;q=0.8');
    await manager.execute('qa', 'close_instance', { instance_id: omitted.instance_id });
    const changed = await manager.execute(
      'qa',
      'create_instance',
      createSchema.parse({
        device_profile_id: 'iphone-standard',
        locale: 'en-US',
        timezone: 'UTC',
      }),
    );
    assert.equal(changed.locale, 'en-US');
    assert.equal(changed.timezone, 'UTC');
    assert.deepEqual(changed.device_profile.languages, ['en-US']);
    assert.equal(changed.device_profile.http_accept_language, 'en-US');
    await manager.execute('qa', 'close_instance', { instance_id: changed.instance_id });
    const zoneOnly = await manager.execute(
      'qa',
      'create_instance',
      createSchema.parse({ device_profile_id: 'iphone-standard', timezone: 'UTC' }),
    );
    assert.equal(zoneOnly.locale, 'en-SG');
    assert.deepEqual(zoneOnly.device_profile.languages, ['en-SG']);
    assert.equal(zoneOnly.device_profile.http_accept_language, 'en-SG,en-GB;q=0.9,en;q=0.8');
    assert.deepEqual(zoneOnly.configuration_sources, {
      locale: 'profile',
      timezone: 'request',
      languages: 'profile',
    });
    await manager.execute('qa', 'close_instance', { instance_id: zoneOnly.instance_id });
    const defaults = await manager.execute('qa', 'create_instance', createSchema.parse({}));
    assert.equal(defaults.locale, 'en-US');
    assert.equal(defaults.timezone, 'UTC');
    assert.equal(defaults.configuration_sources.locale, 'default');
    await manager.execute('qa', 'close_instance', { instance_id: defaults.instance_id });
  } finally {
    await manager.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
