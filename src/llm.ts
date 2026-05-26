import Anthropic from "@anthropic-ai/sdk";
import { config as loadEnv } from "dotenv";

loadEnv();

export const MODEL = "claude-opus-4-7";

const client = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

export function hasLLM(): boolean {
  return client !== null;
}

interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  calls: number;
}

const usage: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  calls: 0,
};

export interface SystemBlock {
  text: string;
  cache: boolean;
}

export async function callJSON<T>(args: {
  system: SystemBlock[];
  user: string;
  maxTokens: number;
}): Promise<T> {
  if (!client) {
    throw new Error("LLM_NOT_CONFIGURED: set ANTHROPIC_API_KEY in .env");
  }

  const baseInstruction =
    'Respond with a single JSON object only. Do NOT wrap it in markdown code fences. Do NOT include any prose before or after the JSON. The first character of your reply must be "{" and the last must be "}".';

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const userContent =
      attempt === 0
        ? `${args.user}\n\n${baseInstruction}`
        : `${args.user}\n\n${baseInstruction} The previous reply was not valid JSON; try again.`;

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: args.maxTokens,
      system: args.system.map((block) =>
        block.cache
          ? { type: "text", text: block.text, cache_control: { type: "ephemeral" } }
          : { type: "text", text: block.text },
      ),
      messages: [{ role: "user", content: userContent }],
    });

    usage.calls += 1;
    usage.input_tokens += response.usage.input_tokens;
    usage.output_tokens += response.usage.output_tokens;
    usage.cache_creation_input_tokens +=
      response.usage.cache_creation_input_tokens || 0;
    usage.cache_read_input_tokens +=
      response.usage.cache_read_input_tokens || 0;

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    try {
      const json = extractJsonObject(text);
      return JSON.parse(json) as T;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("LLM_BAD_JSON: unknown");
}

function extractJsonObject(raw: string): string {
  const start = raw.indexOf("{");
  if (start === -1) {
    throw new Error(`LLM_BAD_JSON: no opening brace in ${raw.slice(0, 80)}`);
  }

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  throw new Error(`LLM_BAD_JSON: unterminated object in ${raw.slice(0, 200)}`);
}

export function getUsage(): Readonly<Usage> {
  return usage;
}

export function formatUsage(): string {
  return [
    `calls=${usage.calls}`,
    `input=${usage.input_tokens}`,
    `output=${usage.output_tokens}`,
    `cache_write=${usage.cache_creation_input_tokens}`,
    `cache_read=${usage.cache_read_input_tokens}`,
  ].join(" ");
}
