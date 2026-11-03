import { z } from "zod";
import { parseJson } from "../fsx.js";

/**
 * What one `claude -p --output-format stream-json --verbose --include-hook-events`
 * run reported about itself: the model, the tools it called, every hook event
 * (there must be none), and the final result with turns, tokens and cost.
 * Lines are validated one by one; a line that is not one of these shapes is
 * counted, not trusted.
 */

const Init = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("init"),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  plugins: z.array(z.looseObject({ name: z.string() })).optional(),
  mcp_servers: z.array(z.unknown()).optional(),
});

const Hook = z.looseObject({
  type: z.literal("system"),
  subtype: z.string().regex(/^hook_/),
  hook_event: z.string().optional(),
  hook_name: z.string().optional(),
});

const Assistant = z.looseObject({
  type: z.literal("assistant"),
  message: z.looseObject({
    content: z
      .array(
        z.looseObject({
          type: z.string(),
          name: z.string().optional(),
          input: z.looseObject({ command: z.string().optional() }).optional(),
        }),
      )
      .optional(),
  }),
});

const Usage = z.looseObject({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
});

const Result = z.looseObject({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  num_turns: z.number().optional(),
  duration_ms: z.number().optional(),
  total_cost_usd: z.number().optional(),
  usage: Usage.optional(),
});

const Line = z.looseObject({ type: z.string() });

export interface Usage {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
}

export interface RunTelemetry {
  model: string | undefined;
  tools: string[];
  plugins: string[];
  mcpServers: number;
  hookEvents: { subtype: string; event: string; name: string }[];
  toolCalls: Record<string, number>;
  /** Every command the agent gave its Bash tool. */
  bashCommands: string[];
  result:
    | {
        subtype: string;
        isError: boolean;
        answer: string;
        turns: number;
        durationMs: number;
        costUsd: number;
        usage: Usage;
      }
    | undefined;
  lines: number;
  unrecognised: number;
}

export const totalTokens = (t: Usage): number => t.input + t.cacheCreation + t.cacheRead + t.output;

export function parseStream(text: string): RunTelemetry {
  const telemetry: RunTelemetry = {
    model: undefined,
    tools: [],
    plugins: [],
    mcpServers: 0,
    hookEvents: [],
    toolCalls: {},
    bashCommands: [],
    result: undefined,
    lines: 0,
    unrecognised: 0,
  };
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    telemetry.lines += 1;
    const json = parseJson(raw);
    const line = json.ok ? Line.safeParse(json.value) : undefined;
    if (!json.ok || line?.success !== true) {
      telemetry.unrecognised += 1;
      continue;
    }
    const value = json.value;
    const init = Init.safeParse(value);
    if (init.success) {
      telemetry.model = init.data.model;
      telemetry.tools = init.data.tools ?? [];
      telemetry.plugins = (init.data.plugins ?? []).map((p) => p.name);
      telemetry.mcpServers = init.data.mcp_servers?.length ?? 0;
      continue;
    }
    const hook = Hook.safeParse(value);
    if (hook.success) {
      telemetry.hookEvents.push({
        subtype: hook.data.subtype,
        event: hook.data.hook_event ?? "",
        name: hook.data.hook_name ?? "",
      });
      continue;
    }
    const assistant = Assistant.safeParse(value);
    if (assistant.success) {
      for (const block of assistant.data.message.content ?? []) {
        if (block.type === "tool_use" && block.name !== undefined) {
          telemetry.toolCalls[block.name] = (telemetry.toolCalls[block.name] ?? 0) + 1;
          if (block.name === "Bash" && block.input?.command !== undefined)
            telemetry.bashCommands.push(block.input.command);
        }
      }
      continue;
    }
    const result = Result.safeParse(value);
    if (result.success) {
      const usage = result.data.usage;
      telemetry.result = {
        subtype: result.data.subtype,
        isError: result.data.is_error ?? false,
        answer: result.data.result ?? "",
        turns: result.data.num_turns ?? 0,
        durationMs: result.data.duration_ms ?? 0,
        costUsd: result.data.total_cost_usd ?? 0,
        usage: {
          input: usage?.input_tokens ?? 0,
          cacheCreation: usage?.cache_creation_input_tokens ?? 0,
          cacheRead: usage?.cache_read_input_tokens ?? 0,
          output: usage?.output_tokens ?? 0,
        },
      };
    }
  }
  return telemetry;
}

/**
 * The most hooks Claude Code's debug log said it had registered, from lines
 * such as "Hooks: Found 0 total hooks in registry". Null when the log has no
 * such line (an older or newer CLI that words it differently).
 */
export function registryHookCount(debugLog: string): number | null {
  let most: number | null = null;
  for (const match of debugLog.matchAll(/Hooks: Found (\d+) total hooks in registry|Registered (\d+) hooks from/g)) {
    const n = Number(match[1] ?? match[2]);
    most = most === null ? n : Math.max(most, n);
  }
  return most;
}

/** Commands that call a package manager, which in a suite with shims must reach the shims. */
export const PACKAGE_MANAGER = /(?:^|[\s;&|(`$])(?:npm|pnpm|npx|yarn|corepack)(?=\s|$)/m;
