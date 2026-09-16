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
