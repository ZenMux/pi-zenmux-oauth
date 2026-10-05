import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('extension factory registers discovered models without a refreshModels hook and caches offline', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-startup-catalog-'));
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: ['test/one', 'test/two'].map(slug => ({ slug, api: 'messages', name: slug })) }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.close(); server.closeAllConnections(); await rm(root, { recursive: true, force: true }); });
  const env = { ...process.env, PI_CODING_AGENT_DIR: root, ZENMUX_MODEL_CATALOG_URL: `http://127.0.0.1:${server.address().port}/models`, ZENMUX_MODEL_CACHE_ORIGIN: 'https://zenmux.ai', NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
  const script = `import provider from ${JSON.stringify(new URL('../index.mjs', import.meta.url).href)}; await provider({registerProvider(name, config){console.log(JSON.stringify({name,models:config.models.map(x=>x.id)}))}});`;
  const execute = async more => JSON.parse((await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: { ...env, ...more } })).stdout);
  assert.deepEqual(await execute({ PI_OFFLINE: '0' }), { name: 'zenmux', models: ['test/one', 'test/two'] });
  assert.equal(requests, 1);
  assert.deepEqual(await execute({ PI_OFFLINE: '1', ZENMUX_OAUTH_ORIGIN: 'http://127.0.0.1:9999' }), { name: 'zenmux', models: ['test/one', 'test/two'] });
  assert.equal(requests, 1);
});

test('refreshModels keeps the full catalog when Pi passes no store (Pi >= 0.87)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-refresh-catalog-'));
  let fail = false;
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    if (fail) { res.statusCode = 503; res.end('{}'); return; }
    res.end(JSON.stringify({ data: ['test/one', 'test/two'].map(slug => ({ slug, api: 'messages', name: slug })) }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.close(); server.closeAllConnections(); await rm(root, { recursive: true, force: true }); });
  const env = { ...process.env, PI_CODING_AGENT_DIR: root, PI_OFFLINE: '0', ZENMUX_MODEL_CATALOG_URL: `http://127.0.0.1:${server.address().port}/models`, ZENMUX_MODEL_CACHE_ORIGIN: 'https://zenmux.ai', NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
  // Pi >= 0.87 calls refreshModels with { credential, stored, publish, allowNetwork, force, signal }:
  // first offline, then online. There is no `store`.
  const script = `import { rm } from 'node:fs/promises';
import provider from ${JSON.stringify(new URL('../index.mjs', import.meta.url).href)};
let config;
await provider({ registerProvider(_name, c) { config = c; } });
const ids = models => models.map(x => x.id);
const context = allowNetwork => ({ credential: undefined, stored: undefined, publish: async () => true, allowNetwork, signal: new AbortController().signal });
const offline = ids(await config.refreshModels(context(false)));
await rm(process.env.PI_CODING_AGENT_DIR + '/zenmux-models.json');
const noCache = ids(await config.refreshModels(context(false)));
console.log(JSON.stringify({ offline, noCache }));`;
  const run = async () => JSON.parse((await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env })).stdout);
  assert.deepEqual(await run(), { offline: ['test/one', 'test/two'], noCache: ['test/one', 'test/two'] });
});
