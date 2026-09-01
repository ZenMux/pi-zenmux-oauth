# ZenMux Pi session header

## Background and problem

Pi supplies the active session identifier to provider stream options, but the
ZenMux provider did not forward it. This prevented request routing and
diagnostics from associating API calls with a Pi session.

## Goals

- Send `x-zenmux-session-id` on every ZenMux model request when Pi provides a
  non-empty `sessionId`.
- Preserve the existing Pi AI provider protocol implementations and any other
  request headers.

## Non-goals

- Changing OAuth credentials or token exchange.
- Sending a header for OAuth or model-catalog requests.
- Inventing a session ID when Pi has not supplied one.

## Affected files

- `index.mjs`: wrap Pi's standard `streamSimple` implementation and add the
  session header from stream options.
- `test/protocol-selection.test.mjs`: cover populated and empty session IDs.
- `package.json` / `package-lock.json`: declare the Pi AI runtime dependency.

## Control flow and compatibility

Pi invokes the registered provider's `streamSimple` function with
`options.sessionId`. The wrapper copies the options and merges existing
headers, then sets `x-zenmux-session-id` to the session ID before delegating to
Pi AI's built-in protocol stream. Requests without a session ID retain their
previous headers and behavior.

## Validation

Run `npm test`, which performs syntax checking and the Node test suite.
