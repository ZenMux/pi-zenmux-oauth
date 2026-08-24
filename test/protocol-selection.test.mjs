import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createModelsCacheEntry,
  oauthCompletionUrl,
  productionOAuthClientId,
  refreshZenMuxModels,
  renderOAuthCompletionPage,
  resolvePiApi,
  resolvePiBaseUrl,
  restoreCachedModels,
  toPiModel,
} from '../index.mjs';

test('ships one stable production OAuth public client', () => {
  assert.equal(productionOAuthClientId, 'zpc_-6SsDHPARf6Rg5TTzbvlOQka');
});

test('renders the Pi completion page in a full-screen iframe', () => {
  const html = renderOAuthCompletionPage();
  assert.equal(oauthCompletionUrl, 'https://zenmux.ai/platform/oauth-completed?client=pi');
  assert.match(html, /<iframe src="https:\/\/zenmux\.ai\/platform\/oauth-completed\?client=pi"/);
  assert.match(html, /html, body, iframe \{ width: 100%; height: 100%; margin: 0; border: 0; \}/);
});

test('prefers Anthropic Messages over Responses and Chat Completions', () => {
  assert.equal(
    resolvePiApi({ supported_endpoint_types: ['chat.completions', 'responses', 'messages'] }),
    'anthropic-messages',
  );
});

test('uses Responses when Anthropic Messages is unavailable', () => {
  assert.equal(
    resolvePiApi({ protocols: ['chat-completions', 'openai-responses'] }),
    'openai-responses',
  );
});

test('uses Chat Completions when it is the only advertised protocol', () => {
  assert.equal(resolvePiApi({ api: 'chat.completions' }), 'openai-completions');
});

test('defaults to Anthropic Messages when discovery has no protocol metadata', () => {
  assert.equal(resolvePiApi({}), 'anthropic-messages');
  assert.equal(toPiModel({ id: 'deepseek/deepseek-v4-flash' }).api, 'anthropic-messages');
});

test('reads endpoint adapter metadata', () => {
  assert.equal(
    resolvePiApi({ endpoints: [{ adapters: [{ api: 'responses' }, { api: 'messages' }] }] }),
    'anthropic-messages',
  );
});

test('maps the rich ZenMux model catalog shape', () => {
  const model = toPiModel({
    slug: 'example/model',
    name: 'Example Model',
    input_modalities: ['text'],
    endpoints: [
      { adapters: [{ api: 'chat.completions' }] },
      {
        context_length: 262144,
        supports_reasoning: 1,
        adapters: [{ api: 'responses' }, { api: 'messages' }],
      },
    ],
  });

  assert.equal(model.id, 'example/model');
  assert.equal(model.name, 'ZenMux · Example Model');
  assert.equal(model.api, 'anthropic-messages');
  assert.equal(model.contextWindow, 262144);
  assert.equal(model.reasoning, true);
});

test('maps every supported ZenMux reasoning mode', () => {
  for (const supportsReasoning of [1, 2, 3]) {
    assert.equal(
      toPiModel({ id: `example/reasoning-${supportsReasoning}`, endpoints: [{ supports_reasoning: supportsReasoning }] })
        .reasoning,
      true,
    );
  }

  assert.equal(toPiModel({ id: 'example/no-reasoning', endpoints: [{ supports_reasoning: 0 }] }).reasoning, false);
});

test('uses the ZenMux Anthropic base URL for Messages', () => {
  assert.equal(resolvePiBaseUrl('anthropic-messages'), 'https://zenmux.ai/api/anthropic');
  assert.equal(resolvePiBaseUrl('openai-responses'), 'https://zenmux.ai/api/v1');
  assert.equal(resolvePiBaseUrl('openai-completions'), 'https://zenmux.ai/api/v1');
});

test('persists and restores the model catalog in Pi store format', () => {
  const model = toPiModel({ id: 'example/cached' });
  const entry = createModelsCacheEntry([model], 1234);

  assert.equal(entry.schemaVersion, 1);
  assert.equal(entry.oauthOrigin, 'https://zenmux.ai');
  assert.equal(entry.modelCatalogUrl, 'https://zenmux.ai/api/frontend/model/available/list');
  assert.equal(entry.checkedAt, 1234);
  assert.equal(entry.models[0].provider, 'zenmux');
  assert.deepEqual(restoreCachedModels(entry), [model]);
});

test('uses cached models without network during Pi startup', async () => {
  const cachedModel = toPiModel({ id: 'example/cached' });
  let networkCalls = 0;
  const models = await refreshZenMuxModels({
    allowNetwork: false,
    store: {
      async read() {
        return createModelsCacheEntry([cachedModel]);
      },
      async write() {
        assert.fail('offline refresh must not write the cache');
      },
    },
  }, [toPiModel({ id: 'example/fallback' })], async () => {
    networkCalls += 1;
    return [];
  });

  assert.equal(networkCalls, 0);
  assert.deepEqual(models, [cachedModel]);
});

test('refreshes and writes a non-empty online catalog', async () => {
  const refreshedModel = toPiModel({ id: 'example/refreshed' });
  let writtenEntry;
  const models = await refreshZenMuxModels({
    allowNetwork: true,
    store: {
      async read() {
        return undefined;
      },
      async write(entry) {
        writtenEntry = entry;
      },
    },
  }, [toPiModel({ id: 'example/fallback' })], async () => [refreshedModel]);

  assert.deepEqual(models, [refreshedModel]);
  assert.deepEqual(restoreCachedModels(writtenEntry), [refreshedModel]);
});

test('keeps a valid cache when online discovery fails or returns empty', async () => {
  const cachedModel = toPiModel({ id: 'example/cached' });
  const fallbackModel = toPiModel({ id: 'example/fallback' });
  const context = {
    allowNetwork: true,
    store: {
      async read() {
        return createModelsCacheEntry([cachedModel]);
      },
      async write() {
        assert.fail('failed discovery must not overwrite the cache');
      },
    },
  };

  assert.deepEqual(
    await refreshZenMuxModels(context, [fallbackModel], async () => []),
    [cachedModel],
  );
  assert.deepEqual(
    await refreshZenMuxModels(context, [fallbackModel], async () => {
      throw new Error('offline');
    }),
    [cachedModel],
  );
});

test('ignores a model cache created for another OAuth origin', async () => {
  const fallbackModel = toPiModel({ id: 'example/fallback' });
  const mismatchedEntry = {
    ...createModelsCacheEntry([toPiModel({ id: 'example/cached' })]),
    oauthOrigin: 'https://pre.zenmux.ai',
  };

  assert.deepEqual(restoreCachedModels(mismatchedEntry), []);
  assert.deepEqual(
    await refreshZenMuxModels({
      allowNetwork: false,
      store: { async read() { return mismatchedEntry; } },
    }, [fallbackModel]),
    [fallbackModel],
  );
});
