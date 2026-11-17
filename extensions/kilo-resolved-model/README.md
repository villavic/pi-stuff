# kilo-resolved-model

Shows which model the `kilo-auto/free` router actually resolves to, surfaced
in the footer status bar handled by `pi-bar`.

## What it does

- Captures the turn context on `session_start` and `model_select`.
- Listens to `provider_stream_event` and `after_provider_response` to read the
  resolved model id from the Kilo Gateway response.
- When `kilo-auto/*` is selected, shows "kilo-auto/free → resolving…" in the
  status bar until the router reveals the physical model, then updates to
  "kilo-auto/free → claude-sonnet-4-20250514".
- Clears the status when the selected model is not `kilo-auto/*`.
- Degrades gracefully when `pi-bar` / `ctx.ui` is unavailable.

## What it does not do

- It is not a Kilo provider (use `@ravshansbox/pi-kilo` for that).
- It does not write anything; it only observes provider responses from the
  Kilo Gateway.
- It does not intercept non-Kilo traffic.

## Enable

Pi discovers `extensions/kilo-resolved-model/index.ts` through the
`pi.extensions` glob in the root `package.json`. Add it to the enabled
extensions via `pi config` (or your session settings). No runtime dependencies
are required.

## Why provider events instead of fetch

Pi makes provider HTTP calls through undici, not `globalThis.fetch`, so a
fetch wrapper cannot observe Kilo Gateway responses. The extension uses
`provider_stream_event` (parsed SSE chunks) and `after_provider_response`
(HTTP headers) instead, which are the events Pi emits for every provider call.

## Background

No existing `pi-package` covered this requirement, so it was written new after
a marketplace search; no existing `pi-package` covered this requirement.
