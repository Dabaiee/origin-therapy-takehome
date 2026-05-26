import { decide, type Decision } from "./classify.js";
import { extract, type Extraction } from "./extract.js";
import { formatUsage, hasLLM } from "./llm.js";
import { runPlaybook } from "./playbooks.js";
import { getToolCallsForItem, withItemContext } from "./tools.js";
import type { InboxItem, ItemOutput } from "./types.js";

const CONCURRENCY = 4;

export async function runAgent(inbox: InboxItem[]): Promise<ItemOutput[]> {
  if (!hasLLM()) {
    console.error(
      "[agent] ANTHROPIC_API_KEY not set — running with deterministic regex fallback only.",
    );
  } else {
    console.error(`[agent] using LLM extraction (Opus 4.7) for ${inbox.length} items`);
  }

  const results: ItemOutput[] = new Array(inbox.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const myIndex = cursor;
      cursor += 1;
      if (myIndex >= inbox.length) return;
      const item = inbox[myIndex];
      try {
        results[myIndex] = await processItem(item);
      } catch (err) {
        console.error(
          `[agent] ${item.id} failed unexpectedly: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        results[myIndex] = buildErrorOutput(item, err);
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(CONCURRENCY, inbox.length) },
    () => worker(),
  );
  await Promise.all(workers);

  console.error(`[agent] llm usage: ${formatUsage()}`);
  return results;
}

async function processItem(item: InboxItem): Promise<ItemOutput> {
  return withItemContext(item.id, async () => {
    const extraction = await extract(item);
    const decision = decide(item, extraction);
    const outcome = await runPlaybook(item, extraction, decision);

    const toolsCalled = getToolCallsForItem(item.id);

    return {
      item_id: item.id,
      classification: decision.classification,
      urgency: decision.urgency,
      requires_human_review: true,
      extracted_intake: extraction.extracted_intake,
      missing_info: dedupe(outcome.missing_info),
      tools_called: toolsCalled,
      recommended_next_action: outcome.recommended_next_action,
      draft_reply: outcome.draft_reply,
      task_ids: outcome.task_ids,
      escalation: decision.escalation,
      decision_rationale: buildRationale(
        extraction,
        decision,
        outcome.decision_extras,
      ),
    };
  });
}

function buildRationale(
  extraction: Extraction,
  decision: Decision,
  extras: string[],
): string {
  const parts: string[] = [extraction.reasoning];
  if (decision.rationale_overrides.length) {
    parts.push(...decision.rationale_overrides);
  }
  for (const extra of extras) {
    if (!parts.includes(extra)) parts.push(extra);
  }
  if (extraction.source === "fallback") {
    parts.push("(Extraction used deterministic regex fallback because the LLM call was unavailable.)");
  }
  return parts.join(" ");
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.filter((v) => v && v.trim().length > 0)));
}

function buildErrorOutput(item: InboxItem, err: unknown): ItemOutput {
  const message = err instanceof Error ? err.message : String(err);
  return {
    item_id: item.id,
    classification: "other",
    urgency: "P2",
    requires_human_review: true,
    extracted_intake: {
      child_name: null,
      dob_or_age: null,
      parent_contact: null,
      discipline: null,
      diagnosis_or_concern: null,
      payer: null,
      member_id: null,
    },
    missing_info: ["all_fields"],
    tools_called: getToolCallsForItem(item.id),
    recommended_next_action:
      "Staff must triage this item manually; the automated agent could not process it.",
    draft_reply: null,
    task_ids: [],
    escalation: null,
    decision_rationale: `Agent failed: ${message}. Item routed to manual triage.`,
  };
}

