import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserManager } from '../src/browser.js';
import { config } from '../src/config.js';
import { definitions } from '../src/tools.js';
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Capability fixture</title><style>body{margin:0}button,input,#drag,#drop{position:absolute;width:120px;height:50px;left:20px}#click{top:20px}#double{top:100px}#right{top:180px}#drag{top:260px;background:blue}#drop{top:260px;left:260px;background:green}#input{top:420px}iframe{position:absolute;top:500px}</style><button id="click">Click</button><button id="double">Double</button><button id="right">Right</button><div id="drag">Drag</div><div id="drop">Drop</div><div id="native" draggable="true" style="position:absolute;left:500px;top:260px;width:120px;height:50px;background:orange">Native drag</div><div id="native-drop" style="position:absolute;left:750px;top:260px;width:120px;height:50px;background:gray">Native drop</div><input id="input" placeholder="Input"><iframe src="/frame"></iframe><script>
window.results={click:0,double:0,right:0,moves:0,dropped:false};
click.onclick=()=>results.click++;double.ondblclick=()=>results.double++;right.oncontextmenu=e=>{e.preventDefault();results.right++};
document.getElementById('native').ondragstart=e=>e.dataTransfer.setData('text/plain','native-value');document.getElementById('native-drop').ondragover=e=>e.preventDefault();document.getElementById('native-drop').ondrop=e=>{e.preventDefault();results.nativeDrop=e.dataTransfer.getData('text/plain')};let dragging=false;document.addEventListener('mousedown',e=>{if(e.target.id==='drag')dragging=true});document.addEventListener('mousemove',e=>{if(dragging)results.moves++});document.addEventListener('mouseup',e=>{if(dragging)results.dropped=e.clientX>=260&&e.clientY>=260;dragging=false});
</script>`;
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'cloudbrowser-capabilities-'));
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.from(c));
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-response-marker', 'response-original');
      res.end(
        JSON.stringify({
          method: req.method,
          body: Buffer.concat(chunks).toString(),
          cookie: req.headers.cookie ?? '',
        }),
      );
      return;
    }
    if (req.url === '/large') {
      res.setHeader('content-type', 'text/plain');
      res.end('x'.repeat(300000));
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/frame' });
      res.end();
      return;
    }
    if (req.url === '/slow') return;
    if (req.url === '/fail') {
      res.destroy();
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/frame' ? '<title>Frame</title><h1>Frame content</h1>' : html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const manager = new BrowserManager({
    ...config(),
    dataDir: dir,
    recordVideo: false,
    allowPrivate: true,
    maxInstances: 4,
  });
  await manager.init();
  const call = (name: string, args: any = {}) =>
    manager.execute('alice', name, definitions[name].schema.parse(args));
  const i = await call('create_instance', { task_description: 'Capabilities test' });
  const ids = { instance_id: i.instance_id, page_id: i.pages[0].page_id };
  await call('navigate', { ...ids, url });
  await call('wait_for', { ...ids, target: { frame: 'iframe', css: 'h1' }, timeout_ms: 5000 });
  return {
    manager,
    call,
    ids,
    url,
    cleanup: async () => {
      await manager.shutdown();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function until<T>(work: () => Promise<T>, pass: (r: T) => boolean) {
  for (let n = 0; n < 100; n++) {
    const r = await work();
    if (pass(r)) return r;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error('Expected asynchronous browser observation did not arrive');
}
test('tab details, frame scripts, structured reads, CSS-pixel mouse actions and page keyboard', async () => {
  const f = await fixture();
  const { call, ids, url } = f;
  try {
    const page = await call('get_page', ids);
    assert.equal(page.title, 'Capability fixture');
    const frame = page.frames.find((v: any) => v.url.endsWith('/frame'));
    assert.ok(frame);
    assert.ok(
      (await call('read_element', { ...ids, target: { frame: 'iframe', css: 'h1' } })).box.y > 500,
    );
    assert.equal(
      (
        await call('evaluate', {
          ...ids,
          frame_id: frame.frame_id,
          script: 'document.querySelector("h1").textContent',
        })
      ).value,
      'Frame content',
    );
    assert.deepEqual(
      (
        await call('evaluate', {
          ...ids,
          script: 'async arg => ({answer:await Promise.resolve(arg.value+1)})',
          arg: { value: 41 },
        })
      ).value,
      { answer: 42 },
    );
    const read = await call('read_element', { ...ids, target: { css: '#click' } });
    assert.equal(read.text, 'Click');
    assert.equal(read.box.x, 20);
    await call('pointer', { ...ids, action: 'click', x: 40, y: 40 });
    await call('pointer', { ...ids, action: 'double_click', x: 40, y: 120 });
    await call('pointer', { ...ids, action: 'right_click', x: 40, y: 200 });
    await call('pointer', {
      ...ids,
      action: 'drag',
      x: 40,
      y: 280,
      to_x: 280,
      to_y: 280,
      steps: 15,
    });
    const result = (await call('evaluate', { ...ids, script: 'window.results' })).value;
    assert.equal(result.click, 1);
    assert.equal(result.double, 1);
    assert.equal(result.right, 1);
    assert.equal(result.dropped, true);
    assert.ok(result.moves >= 10);
    await call('pointer', {
      ...ids,
      action: 'drag',
      x: 520,
      y: 280,
      to_x: 770,
      to_y: 280,
      steps: 15,
    });
    assert.equal(
      (await call('evaluate', { ...ids, script: 'window.results.nativeDrop' })).value,
      'native-value',
    );
    await call('pointer', { ...ids, action: 'click', x: 40, y: 440 });
    await call('keyboard', { ...ids, action: 'type', value: 'original' });
    await call('keyboard', { ...ids, action: 'press', value: 'ControlOrMeta+A' });
    await call('keyboard', { ...ids, action: 'type', value: 'replacement' });
    assert.equal(
      (await call('read_element', { ...ids, target: { css: '#input' } })).value,
      'replacement',
    );
    await assert.rejects(call('pointer', { ...ids, action: 'click', x: 3000, y: 20 }), {
      code: 'INVALID_COORDINATES',
    });
    await call('evaluate', {
      ...ids,
      script: '() => { history.pushState({},"","/spa"); document.title="SPA title"; }',
    });
    const spa = await until(
      () => call('get_page', ids),
      (p: any) => p.title === 'SPA title',
    );
    assert.notEqual(spa.state, 'loading');
    await call('evaluate', {
      ...ids,
      script:
        '() => { document.querySelector("#input").onkeydown = e => { if(e.key==="Enter") window.dialogResult=confirm("keyboard confirmation"); }; }',
    });
    const keyDialog = await call('keyboard', { ...ids, action: 'press', value: 'Enter' });
    assert.equal(keyDialog.pending_dialog.type, 'confirm');
    await call('handle_dialog', { ...ids, accept: true });
    assert.equal((await call('evaluate', { ...ids, script: 'window.dialogResult' })).value, true);
    const other = await call('create_page', { instance_id: ids.instance_id, url: url + '/frame' });
    await call('select_page', { instance_id: ids.instance_id, page_id: ids.page_id });
    assert.equal(
      (await call('get_instance', { instance_id: ids.instance_id })).active_page_id,
      ids.page_id,
    );
    const pages = await call('list_pages', { instance_id: ids.instance_id });
    assert.equal(pages.length, 2);
    assert.equal(pages.filter((v: any) => v.active).length, 1);
    const initialRequests = await call('list_network_requests', {
      instance_id: ids.instance_id,
      page_id: other.page_id,
    });
    assert.ok(initialRequests.entries.some((r: any) => r.navigation && r.url === url + '/frame'));
    const screen = await call('screenshot', { ...ids, target: { css: '#click' } });
    assert.equal(screen.mime, 'image/png');
    assert.equal(screen.preview.width, 120);
    await call('close_page', { instance_id: ids.instance_id, page_id: other.page_id });
    assert.equal(
      (await call('get_page', { instance_id: ids.instance_id, page_id: other.page_id })).state,
      'closed',
    );
  } finally {
    await f.cleanup();
  }
});
test('metadata queries remain responsive during scripts, and synchronous or asynchronous script timeouts require reload', async () => {
  const f = await fixture();
  const { call, ids } = f;
  try {
    const pending = call('evaluate', {
      ...ids,
      script: '() => new Promise(r=>setTimeout(()=>r("done"),500))',
    });
    await new Promise((r) => setTimeout(r, 30));
    const start = Date.now();
    assert.equal((await call('get_instance', { instance_id: ids.instance_id })).busy, true);
    assert.ok((await call('list_pages', { instance_id: ids.instance_id })).length);
    await call('get_page', ids);
    await call('list_network_requests', ids);
    await call('get_console_logs', ids);
    assert.ok(Date.now() - start < 1000);
    assert.equal((await pending).value, 'done');
    for (const script of ['() => new Promise(()=>{})', '() => { while(true){} }']) {
      const rejected = assert.rejects(call('evaluate', { ...ids, script, timeout_ms: 600 }), {
        code: 'SCRIPT_TIMEOUT',
      });
      await new Promise((r) => setTimeout(r, 30));
      assert.equal((await call('get_instance', { instance_id: ids.instance_id })).busy, true);
      await call('get_page', ids);
      await call('list_pages', { instance_id: ids.instance_id });
      await rejected;
      assert.equal((await call('get_page', ids)).requires_reload, true);
      await assert.rejects(
        call('interact', {
          ...ids,
          action: 'fill',
          target: { css: '#input' },
          value: 'unsafe-retry',
        }),
        { code: 'PAGE_RELOAD_REQUIRED' },
      );
      await call('navigate', { ...ids, action: 'reload' });
      assert.equal((await call('evaluate', { ...ids, script: '2+2' })).value, 4);
    }
    await assert.rejects(
      call('evaluate', { ...ids, script: '() => {throw Error("original script error") }' }),
      { code: 'SCRIPT_ERROR' },
    );
    await assert.rejects(
      call('evaluate', { ...ids, script: '"x".repeat(2000)', max_result_bytes: 256 }),
      { code: 'SCRIPT_RESULT_TOO_LARGE' },
    );
    await assert.rejects(call('evaluate', { ...ids, script: '1n' }), {
      code: 'SCRIPT_RESULT_NOT_SERIALIZABLE',
    });
  } finally {
    await f.cleanup();
  }
});
test('network and console capture retain original contents with per-tab request IDs, redirects, cursors and bounded history', async () => {
  const f = await fixture();
  const { call, ids, url, manager } = f;
  try {
    await call('evaluate', {
      ...ids,
      script: `async () => { document.cookie='session=original-cookie'; console.log('original log'); console.warn('original warning'); setTimeout(()=>{throw Error('original page exception')},0); return await (await fetch('/api',{method:'POST',headers:{'content-type':'application/json','x-marker':'request-original'},body:JSON.stringify({password:'visible-original'})})).json() }`,
    });
    const listing = await until(
      () => call('list_network_requests', { ...ids, url: '/api' }),
      (v: any) => v.entries.some((r: any) => r.response_body_status === 'available'),
    );
    const request = listing.entries.find((r: any) => r.url.endsWith('/api'));
    const detail = await call('get_network_request', { ...ids, request_id: request.request_id });
    assert.equal(detail.status_code, 200);
    assert.equal(detail.request_headers['x-marker'], 'request-original');
    assert.ok(detail.request_headers.cookie.includes('original-cookie'));
    assert.equal(detail.response_headers['x-response-marker'], 'response-original');
    assert.ok(detail.request_body.data.includes('visible-original'));
    assert.ok(detail.response_body.data.includes('visible-original'));
    assert.equal(detail.response_body.truncated, false);
    assert.deepEqual(
      (
        await call('list_network_requests', {
          ...ids,
          after_seq: listing.next_after_seq,
          url: '/api',
        })
      ).entries,
      [],
    );
    const next = await call('create_page', { instance_id: ids.instance_id, url: url + '/frame' });
    await assert.rejects(
      call('get_network_request', {
        instance_id: ids.instance_id,
        page_id: next.page_id,
        request_id: request.request_id,
      }),
      { code: 'REQUEST_NOT_FOUND' },
    );
    await assert.rejects(
      manager.execute('bob', 'get_network_request', { ...ids, request_id: request.request_id }),
      { code: 'INSTANCE_NOT_FOUND' },
    );
    const console = await until(
      () => call('get_console_logs', ids),
      (r: any) => r.entries.some((v: any) => v.level === 'pageerror'),
    );
    assert.ok(console.entries.some((v: any) => v.text === 'original log'));
    assert.ok(
      console.entries.some((v: any) => v.level === 'warning' && v.text === 'original warning'),
    );
    assert.ok(console.entries.some((v: any) => v.stack?.includes('original page exception')));
    await call('evaluate', {
      ...ids,
      script: `async()=>{await fetch('/large');await fetch('/redirect');await fetch('/fail');try{await fetch('/slow',{signal:AbortSignal.timeout(30)})}catch{}}`,
    });
    const network = await until(
      () => call('list_network_requests', { ...ids, limit: 200 }),
      (v: any) =>
        v.entries.some(
          (r: any) => r.url.endsWith('/large') && r.response_body_status === 'too_large',
        ) && v.entries.some((r: any) => r.url.endsWith('/slow') && r.status === 'failed'),
    );
    assert.ok(network.entries.some((r: any) => r.redirect_from));
    assert.ok(network.entries.some((r: any) => r.status === 'failed'));
    await call('evaluate', {
      ...ids,
      script: `async()=>{for(let n=0;n<215;n++)await fetch('/api?n='+n)}`,
      timeout_ms: 30000,
    });
    const bounded = await call('list_network_requests', { ...ids, after_seq: 0, limit: 200 });
    assert.ok(bounded.entries.length <= 200);
    assert.ok(bounded.dropped_entries > 0);
    assert.equal(bounded.history_truncated, true);
  } finally {
    await f.cleanup();
  }
});
test('private login state preserves cookies, localStorage and IndexedDB across instances and restores existing contexts', async () => {
  const f = await fixture();
  const { call, ids, url, manager } = f;
  try {
    await call('evaluate', {
      ...ids,
      script: `async()=>{document.cookie='auth=saved-login;path=/';localStorage.setItem('login','saved-value');await new Promise((resolve,reject)=>{const open=indexedDB.open('auth-db',1);open.onupgradeneeded=()=>open.result.createObjectStore('tokens');open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result;const tx=db.transaction('tokens','readwrite');tx.objectStore('tokens').put('saved-token','token');tx.oncomplete=()=>{db.close();resolve(true)}}})}`,
    });
    const saved = await call('save_storage_state', {
      instance_id: ids.instance_id,
      indexed_db: true,
    });
    assert.ok(saved.storage_state_id);
    assert.equal(saved.cookies, 1);
    await call('close_instance', { instance_id: ids.instance_id });
    const restored = await call('create_instance', { storage_state_id: saved.storage_state_id });
    const next = { instance_id: restored.instance_id, page_id: restored.pages[0].page_id };
    await call('navigate', { ...next, url });
    const values = await call('evaluate', {
      ...next,
      script: `async()=>({cookie:document.cookie,storage:localStorage.getItem('login'),token:await new Promise((resolve,reject)=>{const open=indexedDB.open('auth-db');open.onsuccess=()=>{const db=open.result;const tx=db.transaction('tokens');const req=tx.objectStore('tokens').get('token');req.onsuccess=()=>{db.close();resolve(req.result)};req.onerror=()=>reject(req.error)}})})`,
    });
    assert.ok(values.value.cookie.includes('auth=saved-login'));
    assert.equal(values.value.storage, 'saved-value');
    assert.equal(values.value.token, 'saved-token');
    await call('evaluate', {
      ...next,
      script: `()=>{localStorage.setItem('login','changed');document.cookie='auth=changed;path=/';}`,
    });
    await call('restore_storage_state', {
      instance_id: next.instance_id,
      storage_state_id: saved.storage_state_id,
    });
    await call('navigate', { ...next, action: 'reload' });
    assert.equal(
      (await call('evaluate', { ...next, script: 'localStorage.getItem("login")' })).value,
      'saved-value',
    );
    await assert.rejects(
      manager.execute('bob', 'create_instance', { storage_state_id: saved.storage_state_id }),
      { code: 'ARTIFACT_NOT_FOUND' },
    );
    const malformed = await call('put_artifact', {
      name: 'bad.json',
      data_base64: Buffer.from(
        '{"cookies":[],"origins":[{"origin":"file:///etc","localStorage":[]}]}',
      ).toString('base64'),
    });
    await assert.rejects(call('create_instance', { storage_state_id: malformed.id }), {
      code: 'INVALID_URL',
    });
  } finally {
    await f.cleanup();
  }
});
