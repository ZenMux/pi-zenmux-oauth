import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Isolate module-level OAuth origin/client configuration from production.
test('Pi 1.3 OAuth login, PKCE, locked refresh rotation, and cancellation', async t => {
  const grants = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const params = new URLSearchParams(body); grants.push(params);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ access_token: params.get('grant_type') === 'refresh_token' ? 'rotated-access' : 'initial-access', refresh_token: params.get('grant_type') === 'refresh_token' ? 'rotated-refresh' : 'initial-refresh', expires_in: 3600 }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const script = `
    import assert from 'node:assert/strict';
    import {createHash} from 'node:crypto';
    import extension from ${JSON.stringify(new URL('../index.mjs', import.meta.url).href)};
    import {createModels, InMemoryModelsStore} from '@earendil-works/pi-ai';
    const {AuthStorage}=await import(new URL('./core/auth-storage.js',import.meta.resolve('@earendil-works/pi-coding-agent')));
    const credentials=AuthStorage.inMemory();
    const models=createModels({credentials,modelsStore:new InMemoryModelsStore()});
    await extension({registerProvider:p=>models.setProvider(p)});
    let challenge;
    await models.login('zenmux','oauth',{signal:AbortSignal.timeout(5000),prompt:async()=>'',notify:event=>{
      if(event.type==='auth_url'){
        const url=new URL(event.url);challenge=url.searchParams.get('code_challenge');
        assert.equal(url.searchParams.get('scope'),'inference:invoke offline_access');
        const callback=new URL(url.searchParams.get('redirect_uri'));
        callback.searchParams.set('state',url.searchParams.get('state'));callback.searchParams.set('code','mock-code');
        fetch(callback).then(async r=>{assert.equal(r.status,200);assert.match(await r.text(),/iframe/);});
      }
    }});
    const initial=await credentials.read('zenmux'); assert.equal(initial.access,'initial-access');
    await credentials.modify('zenmux',async c=>({...c,expires:0}));
    const auths=await Promise.all([models.getAuth('zenmux'),models.getAuth('zenmux')]);
    for(const auth of auths){assert.equal(auth.auth.apiKey,'rotated-access');assert.equal(auth.auth.headers.Authorization,'Bearer rotated-access');}
    assert.equal((await credentials.read('zenmux')).refresh,'rotated-refresh');
    await assert.rejects(models.login('zenmux','oauth',{signal:AbortSignal.abort(),prompt:async()=>'',notify:()=>{}}));
    const controller=new AbortController();
    await assert.rejects(models.login('zenmux','oauth',{signal:controller.signal,prompt:async()=>'',notify:e=>{if(e.type==='auth_url')controller.abort();}}));
    console.log(JSON.stringify({challenge}));
  `;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, PI_OFFLINE: '1', ZENMUX_OAUTH_ORIGIN: `http://127.0.0.1:${server.address().port}`, ZENMUX_OAUTH_CLIENT_ID: 'mock-client' }, timeout: 10000 });
  assert.equal(grants.length, 2, 'concurrent auth must refresh a rotating token only once');
  assert.equal(grants[0].get('code'), 'mock-code');
  const {createHash}=await import('node:crypto');
  assert.equal(createHash('sha256').update(grants[0].get('code_verifier')).digest('base64url'), JSON.parse(result.stdout).challenge);
  assert.equal(grants[1].get('refresh_token'), 'initial-refresh');
});
