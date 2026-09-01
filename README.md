# pi-zenmux-oauth

Use [ZenMux](https://zenmux.ai) models in Pi with OAuth 2.0 Authorization Code + PKCE. The extension registers the `zenmux` provider, discovers the current model catalog, and refreshes OAuth tokens with rotation.

Model requests prefer Anthropic Messages, then OpenAI Responses, and use Chat Completions only as a compatibility fallback. Protocol selection is performed per model from the endpoint adapters advertised by the ZenMux model catalog; the local fallback model uses Anthropic Messages when discovery is unavailable.

## Add and update the plugin

Install the package with Pi:

```bash
pi install npm:@zenmux/pi-zenmux-oauth
```

If it is already installed, update only this plugin:

```bash
pi update npm:@zenmux/pi-zenmux-oauth
```

To update all installed Pi extensions instead:

```bash
pi update --extensions
```

After updating, restart Pi so it reloads the new extension version. Check the
installed package with:

```bash
pi list
```

## Sign in and use

Start Pi and sign in:

```text
/login zenmux
```

Pi opens the ZenMux authorization page in your browser. After approval, the browser redirects to a temporary loopback listener on `127.0.0.1`, which renders `https://zenmux.ai/platform/oauth-completed?client=pi` in a full-screen iframe. Return to Pi, run `/model`, and select a ZenMux model.

## How authentication works

- The official `https://zenmux.ai` service uses one bundled native public OAuth client ID.
- Authorization uses PKCE with `S256`; no client secret is stored or distributed.
- Existing client IDs are still read from `~/.pi/zenmux-oauth-clients.json` to keep previously issued credentials working. Non-production origins register and cache a client on first use.
- Access and refresh tokens are managed by Pi's provider credential store.
- Refresh tokens rotate on every refresh.
- Model requests use the OAuth access token as a Bearer token. ZenMux API keys are not exposed to the extension.
- The discovered model catalog is cached by Pi in `~/.pi/agent/models-store.json`. The extension restores it at startup, refreshes it when network access is allowed, and keeps the last valid catalog when discovery fails or returns empty.
- Cached models are scoped to the configured OAuth origin and model catalog URL, so production and development catalogs are not mixed.

The package requests only these scopes:

- `inference:invoke`
- `offline_access`

## Configuration

Production works without additional configuration. These environment variables are available for development and self-hosted testing:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ZENMUX_OAUTH_ORIGIN` | `https://zenmux.ai` | OAuth authorization server origin |
| `ZENMUX_API_BASE_URL` | `https://zenmux.ai/api/v1` | OpenAI-compatible API base URL |
| `ZENMUX_ANTHROPIC_BASE_URL` | derived as `https://zenmux.ai/api/anthropic` | Anthropic-compatible API base URL |
| `ZENMUX_MODEL_CATALOG_URL` | `https://zenmux.ai/api/frontend/model/available/list` | Rich model catalog containing endpoint protocol adapters |
| `ZENMUX_TEST_MODEL` | `deepseek/deepseek-v4-flash` | Fallback model when discovery is unavailable |
| `ZENMUX_OAUTH_CLIENT_ID` | bundled for `https://zenmux.ai` | Override the public client ID for development or self-hosted environments |

## Local development

Load the extension directly:

```bash
pi -e ./index.mjs
```

Run against the ZenMux pre-release OAuth environment:

```bash
npm run dev
```

Validate the source and inspect the npm tarball before publishing:

```bash
npm test
npm pack --dry-run
```

## Security

Pi packages execute with the permissions of the Pi process. Review package source before installation. This extension listens only on an ephemeral `127.0.0.1` port during OAuth authorization and verifies the returned OAuth state before exchanging the authorization code.

## License

MIT
