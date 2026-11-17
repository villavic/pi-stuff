/**
 * kilo-resolved-model — show which model the `kilo-auto/free` router is using.
 *
 * Captures the turn context on `turn_start` and `model_select`, and listens to
 * `provider_stream_event` / `after_provider_response` to read the resolved
 * model id from the Kilo Gateway response. The resolved model id is shown in
 * the footer status bar via `ctx.ui.setStatus`.
 *
 * When the selected model is `kilo-auto/*` the badge shows "resolving…" until
 * the router's response reveals the physical model, then updates to just the
 * resolved model name (e.g. "claude-sonnet-4-20250514"). When the selected
 * model is not `kilo-auto/*` the status is cleared. Nothing is written; only
 * provider responses from the Kilo Gateway are observed.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "kilo-resolved-model";
const KILO_PREFIX = "kilo-auto/";

let lastCtx: ExtensionContext | null = null;
let lastResolved = "";

function setStatus(ctx: ExtensionContext | null, text: string | undefined) {
  if (!ctx || !ctx.ui) return;
  ctx.ui.setStatus(STATUS_KEY, text);
}

function isKiloModel(modelId: string): boolean {
  return modelId.startsWith(KILO_PREFIX);
}

/**
 * Best-effort extraction of the resolved physical model from a parsed provider
 * stream event. Kilo Gateway is OpenAI-compatible; the resolved model lives in
 * the top-level `model` field of the response object. Generation IDs (`id`:
 * `gen-...`, `chatcmpl-...`) are deliberately ignored — they are not model names.
 */
function tryExtractResolvedModel(
  data: unknown,
  requestedModel: string,
): string | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  const model = obj.model;
  if (
    typeof model === "string" &&
    model.length > 0 &&
    model !== requestedModel &&
    !model.startsWith(KILO_PREFIX)
  ) {
    return model;
  }
  return null;
}

/**
 * Best-effort extraction of the resolved model from response headers. Some
 * gateways set `x-kilo-model`, `x-router-model`, or similar.
 */
function tryExtractFromHeaders(headers: Record<string, string>): string | null {
  for (const [key, value] of Object.entries(headers)) {
    const lk = key.toLowerCase();
    if (
      (lk.includes("kilo") || lk.includes("router") || lk.endsWith("-model")) &&
      typeof value === "string" &&
      value.length > 0 &&
      !value.startsWith(KILO_PREFIX)
    ) {
      return value;
    }
  }
  return null;
}

export default function kiloResolvedModel(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    const modelId = String(ctx.model?.id ?? "");
    if (isKiloModel(modelId)) {
      setStatus(ctx, `${modelId} → resolving…`);
    }
  });

  pi.on("model_select", (event, ctx) => {
    lastCtx = ctx;
    const modelId = String(event?.model?.id ?? "");
    if (!isKiloModel(modelId)) {
      lastResolved = "";
      setStatus(ctx, undefined);
      return;
    }
    lastResolved = "";
    setStatus(ctx, `${modelId} → resolving…`);
  });

  pi.on("provider_stream_event", (event) => {
    const requested = String(event.model);
    if (!isKiloModel(requested)) return;
    const resolved = tryExtractResolvedModel(event.data, requested);
    if (resolved && resolved !== lastResolved) {
      lastResolved = resolved;
      setStatus(lastCtx, resolved);
    }
  });

  pi.on("after_provider_response", (event) => {
    if (!lastCtx) return;
    const headers = event.headers ?? {};
    const resolved = tryExtractFromHeaders(headers);
    if (resolved && resolved !== lastResolved) {
      lastResolved = resolved;
      setStatus(lastCtx, resolved);
    }
  });
}
