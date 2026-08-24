import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const portalOrigin = (process.env.ZENMUX_OAUTH_ORIGIN || 'https://zenmux.ai').replace(/\/$/, '');
const apiBaseUrl = (process.env.ZENMUX_API_BASE_URL || 'https://zenmux.ai/api/v1').replace(/\/$/, '');
const productionOAuthOrigin = 'https://zenmux.ai';
export const productionOAuthClientId = 'zpc_-6SsDHPARf6Rg5TTzbvlOQka';
const anthropicBaseUrl = (
  process.env.ZENMUX_ANTHROPIC_BASE_URL || apiBaseUrl.replace(/\/v1$/, '/anthropic')
).replace(/\/$/, '');
const modelCatalogUrl = process.env.ZENMUX_MODEL_CATALOG_URL
  || `${new URL(apiBaseUrl).origin}/api/frontend/model/available/list`;
let clientId = process.env.ZENMUX_OAUTH_CLIENT_ID || '';
const defaultModel = process.env.ZENMUX_TEST_MODEL || 'deepseek/deepseek-v4-flash';
const clientCachePath = join(homedir(), '.pi', 'zenmux-oauth-clients.json');
const providerId = 'zenmux';
const modelCacheSchemaVersion = 1;
export const oauthCompletionUrl = 'https://zenmux.ai/platform/oauth-completed?client=pi';

export function renderOAuthCompletionPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ZenMux authorization completed</title>
  <style>
    html, body, iframe { width: 100%; height: 100%; margin: 0; border: 0; }
    body { overflow: hidden; }
    iframe { display: block; }
  </style>
</head>
<body>
  <iframe src="${oauthCompletionUrl}" title="ZenMux authorization completed"></iframe>
</body>
</html>`;
}

const protocolAliases = new Map([
  ['anthropic', 'anthropic-messages'],
  ['anthropic-messages', 'anthropic-messages'],
  ['messages', 'anthropic-messages'],
  ['openai-responses', 'openai-responses'],
  ['responses', 'openai-responses'],
  ['chat.completions', 'openai-completions'],
  ['chat-completions', 'openai-completions'],
  ['openai-completions', 'openai-completions'],
]);
const protocolPriority = ['anthropic-messages', 'openai-responses', 'openai-completions'];

function base64Url(buffer) {
  return buffer.toString('base64url');
}

function createPkce() {
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function collectModelProtocols(model) {
  const protocols = [];
  const append = (value) => {
    if (Array.isArray(value)) {
      value.forEach(append);
    } else if (typeof value === 'string') {
      value.split(',').forEach((item) => protocols.push(item.trim().toLowerCase()));
    }
  };

  append(model.api);
  append(model.protocols);
  append(model.supported_endpoint_types);
  append(model.capabilities?.protocols);
  for (const endpoint of model.endpoints ?? []) {
    append(endpoint.api);
    append(endpoint.suitable_api);
    for (const adapter of endpoint.adapters ?? []) append(adapter.api);
  }
  return protocols;
}

function supportsLanguageModelProtocol(model) {
  return collectModelProtocols(model).some((protocol) => protocolAliases.has(protocol));
}

export function resolvePiApi(model) {
  const supported = new Set(
    collectModelProtocols(model).map((protocol) => protocolAliases.get(protocol)).filter(Boolean),
  );
  return protocolPriority.find((protocol) => supported.has(protocol)) ?? 'anthropic-messages';
}

export function resolvePiBaseUrl(api) {
  return api === 'anthropic-messages' ? anthropicBaseUrl : apiBaseUrl;
}

export function toPiModel(model) {
  const input = Array.isArray(model.input_modalities)
    ? model.input_modalities.filter((item) => item === 'text' || item === 'image')
    : ['text'];
  const api = resolvePiApi(model);
  const id = model.slug || model.id;
  const endpointContextWindows = (model.endpoints ?? [])
    .map((endpoint) => endpoint.context_length)
    .filter((value) => Number.isFinite(value));
  const endpointReasoning = (model.endpoints ?? []).some(
    (endpoint) => Number(endpoint.supports_reasoning) > 0,
  );
  return {
    id,
    name: `ZenMux · ${model.display_name || model.name || id}`,
    api,
    baseUrl: resolvePiBaseUrl(api),
    reasoning: model.capabilities?.reasoning === true || endpointReasoning,
    input: input.length ? input : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.context_length || Math.max(0, ...endpointContextWindows) || 128000,
    maxTokens: 16384,
  };
}

async function fetchModels(signal) {
  const response = await fetch(modelCatalogUrl, { signal });
  const payload = await response.json();
  if (!response.ok || !Array.isArray(payload.data)) {
    throw new Error(`ZenMux model discovery failed (${response.status})`);
  }
  return payload.data
    .filter((model) => typeof (model?.id || model?.slug) === 'string')
    .filter(supportsLanguageModelProtocol)
    .map(toPiModel);
}

export function createModelsCacheEntry(models, checkedAt = Date.now()) {
  return {
    schemaVersion: modelCacheSchemaVersion,
    oauthOrigin: portalOrigin,
    modelCatalogUrl,
    models: models.map((model) => ({ ...model, provider: providerId })),
    checkedAt,
  };
}

export function restoreCachedModels(entry) {
  if (
    entry?.schemaVersion !== modelCacheSchemaVersion
    || entry.oauthOrigin !== portalOrigin
    || entry.modelCatalogUrl !== modelCatalogUrl
    || !Array.isArray(entry.models)
  ) {
    return [];
  }

  return entry.models
    .filter((model) => model?.provider === providerId && typeof model.id === 'string' && model.id)
    .map(({ provider: _provider, ...model }) => model);
}

export async function refreshZenMuxModels(context, fallbackModels, discoverModels = fetchModels) {
  let cachedModels = [];
  try {
    cachedModels = restoreCachedModels(await context?.store?.read?.());
  } catch {
    // A missing or unreadable cache must not prevent model discovery.
  }

  const availableModels = cachedModels.length ? cachedModels : fallbackModels;
  if (context?.allowNetwork === false || context?.signal?.aborted) return availableModels;

  try {
    const refreshedModels = await discoverModels(context?.signal);
    if (!Array.isArray(refreshedModels) || !refreshedModels.length || context?.signal?.aborted) {
      return availableModels;
    }

    try {
      await context?.store?.write?.(createModelsCacheEntry(refreshedModels));
    } catch {
      // Cache persistence is best-effort; the live catalog is still usable.
    }
    return refreshedModels;
  } catch {
    return availableModels;
  }
}

async function exchangeToken(body, signal) {
  const response = await fetch(`${portalOrigin}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || `OAuth token request failed (${response.status})`);
  }
  return payload;
}

async function readCachedClientId() {
  try {
    const cache = JSON.parse(await readFile(clientCachePath, 'utf8'));
    return cache[portalOrigin] || null;
  } catch {
    return null;
  }
}

async function saveClientId(value) {
  let cache = {};
  try {
    cache = JSON.parse(await readFile(clientCachePath, 'utf8'));
  } catch {
    // First registration has no cache file yet.
  }
  cache[portalOrigin] = value;
  await mkdir(dirname(clientCachePath), { recursive: true });
  await writeFile(clientCachePath, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
}

async function getClientId() {
  if (clientId) return clientId;
  const cached = await readCachedClientId();
  if (cached) {
    clientId = cached;
    return clientId;
  }
  if (portalOrigin === productionOAuthOrigin) {
    clientId = productionOAuthClientId;
    return clientId;
  }
  const response = await fetch(`${portalOrigin}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'ZenMux for Pi',
      application_type: 'native',
      token_endpoint_auth_method: 'none',
      redirect_uris: ['http://127.0.0.1/callback'],
      scope: 'inference:invoke offline_access',
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.client_id) {
    throw new Error(payload.message || payload.error || `ZenMux client registration failed (${response.status})`);
  }
  clientId = payload.client_id;
  await saveClientId(clientId);
  return clientId;
}

async function login(callbacks) {
  const currentClientId = await getClientId();
  const { verifier, challenge } = createPkce();
  const state = base64Url(randomBytes(32));

  const callback = await new Promise((resolve, reject) => {
    let redirectUri = '';
    let settled = false;
    const server = createServer((request, response) => {
      if (!redirectUri || settled) {
        response.writeHead(409).end('OAuth callback is no longer active');
        return;
      }
      const requestUrl = new URL(request.url || '/', redirectUri);
      if (requestUrl.pathname !== '/callback') {
        response.writeHead(404).end('Not found');
        return;
      }
      const returnedState = requestUrl.searchParams.get('state');
      const code = requestUrl.searchParams.get('code');
      const oauthError = requestUrl.searchParams.get('error');
      if (oauthError || returnedState !== state || !code) {
        settled = true;
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('ZenMux authorization failed. You can close this window.');
        server.close();
        reject(new Error(oauthError || 'OAuth callback state mismatch'));
        return;
      }
      settled = true;
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(renderOAuthCompletionPage());
      server.close();
      resolve({ code, redirectUri });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      redirectUri = `http://127.0.0.1:${address.port}/callback`;
      const authorizeUrl = new URL(`${portalOrigin}/oauth/authorize`);
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('client_id', currentClientId);
      authorizeUrl.searchParams.set('redirect_uri', redirectUri);
      authorizeUrl.searchParams.set('scope', 'inference:invoke offline_access');
      authorizeUrl.searchParams.set('state', state);
      authorizeUrl.searchParams.set('code_challenge', challenge);
      authorizeUrl.searchParams.set('code_challenge_method', 'S256');
      callbacks.onProgress?.('Waiting for ZenMux authorization in your browser…');
      callbacks.onAuth({ url: authorizeUrl.toString() });
    });
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error('ZenMux OAuth callback timed out after 5 minutes'));
    }, 5 * 60 * 1000);
    timeout.unref();
  });

  const tokens = await exchangeToken(new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: currentClientId,
    code: callback.code,
    redirect_uri: callback.redirectUri,
    code_verifier: verifier,
  }));
  if (!tokens.refresh_token) throw new Error('ZenMux did not return a refresh token');
  return {
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: Date.now() + tokens.expires_in * 1000,
  };
}

export default function zenMuxProvider(pi) {
  const fallbackModel = toPiModel({ id: defaultModel });
  pi.registerProvider(providerId, {
    name: 'ZenMux',
    baseUrl: apiBaseUrl,
    api: 'anthropic-messages',
    authHeader: true,
    models: [fallbackModel],
    async refreshModels(context) {
      return refreshZenMuxModels(context, [fallbackModel]);
    },
    oauth: {
      name: 'ZenMux OAuth (PKCE)',
      login,
      async refreshToken(credentials, signal) {
        const currentClientId = await getClientId();
        const tokens = await exchangeToken(new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: currentClientId,
          refresh_token: credentials.refresh,
        }), signal);
        if (!tokens.refresh_token) throw new Error('ZenMux refresh token rotation failed');
        return {
          access: tokens.access_token,
          refresh: tokens.refresh_token,
          expires: Date.now() + tokens.expires_in * 1000,
        };
      },
      getApiKey(credentials) {
        return credentials.access;
      },
    },
  });
}
