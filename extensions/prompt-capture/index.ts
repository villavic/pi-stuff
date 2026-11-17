// Capture what Pi sends to the model, for prompt-size inspection.
//
// Load: pi -e extensions/prompt-capture/index.ts
//   /prompt-size            dump prompt sections + tool declarations
//                           (no model call, works with the endpoint down)
//   every provider request  -> <cwd>/.pi/prompt-capture/req-NNN.json
//
// Report: node lab/tmp/prompt-report.mjs <cwd>/.pi/prompt-capture

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

type PromptOptions = NonNullable<
  ReturnType<ExtensionCommandContext["getSystemPromptOptions"]>
>;

const CAPTURE_DIR = join(".pi", "prompt-capture");

function dump(dir: string, name: string, data: unknown) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return path;
}

function summarise(options: PromptOptions, tools: ReturnType<ExtensionAPI["getAllTools"]>, active: string[]) {
  const sections = options.sections ?? {};
  const activeSet = new Set(active);
  const declared = tools.filter((tool) => activeSet.has(tool.name));
  const bySource = new Map<string, number>();
  for (const tool of declared) {
    const key = tool.sourceInfo?.source ?? "unknown";
    bySource.set(key, (bySource.get(key) ?? 0) + declarationBytes(tool));
  }
  return {
    sections: Object.entries(sections).map(([name, body]) => ({
      name,
      bytes: Buffer.byteLength(String(body ?? "")),
    })),
    activeTools: active,
    toolDeclarations: declared.map((tool) => ({
      name: tool.name,
      source: tool.sourceInfo?.source ?? "unknown",
      path: tool.sourceInfo?.path,
      descriptionBytes: Buffer.byteLength(tool.description ?? ""),
      schemaBytes: Buffer.byteLength(JSON.stringify(tool.parameters ?? {})),
    })),
    declarationBytesBySource: [...bySource.entries()]
      .map(([source, bytes]) => ({ source, bytes }))
      .sort((a, b) => b.bytes - a.bytes),
  };
}

function declarationBytes(tool: {
  name: string;
  description?: string;
  parameters?: unknown;
}) {
  return Buffer.byteLength(
    JSON.stringify({
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.parameters ?? {},
    }),
  );
}

export default function (pi: ExtensionAPI) {
  let requests = 0;

  // Ground truth: the provider payload right before the HTTP call.
  pi.on("before_provider_request", (event, ctx) => {
    requests += 1;
    const name = `req-${String(requests).padStart(3, "0")}.json`;
    dump(join(ctx.cwd, CAPTURE_DIR), name, event.payload);
  });

  // Structure without a round trip: Pi's own prompt inputs and tool set.
  pi.registerCommand("prompt-size", {
    description: "Dump prompt sections and tool declarations for size report",
    handler: async (_args, ctx) => {
      const systemPrompt = ctx.getSystemPrompt();
      const options = ctx.getSystemPromptOptions();
      const active = pi.getActiveTools();
      const report = {
        cwd: ctx.cwd,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        systemPromptBytes: Buffer.byteLength(systemPrompt),
        selectedTools: options.selectedTools,
        hiddenTools: options.hiddenTools,
        promptSnippets: Object.keys(options.toolSnippets ?? {}),
        ...summarise(options, pi.getAllTools(), active),
      };
      const path = dump(join(ctx.cwd, CAPTURE_DIR), "prompt-structure.json", report);
      const total = report.declarationBytesBySource.reduce(
        (sum, entry) => sum + entry.bytes,
        0,
      );
      ctx.ui.notify(
        `prompt ${report.systemPromptBytes} B + tools ${total} B ` +
          `(${active.length} active) -> ${path}`,
        "info",
      );
    },
  });
}