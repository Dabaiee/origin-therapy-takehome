// Per-item expected-behavior eval for the triage agent.
//
// Run `npm run triage` first, then `npm run eval` to score the output against
// the behaviors we expect for each of the 8 visible inbox items. Exits with
// non-zero status if any assertion fails. Designed to be the kind of script
// that would live in CI as the agent's behavioral regression net — the
// validator catches schema bugs, this catches judgment bugs.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BatchOutput, ItemOutput } from "./types.js";

interface AssertionResult {
  item_id: string;
  label: string;
  passed: boolean;
  detail?: string;
}

function main(): void {
  const output = readOutput("output.json");
  const itemsById = new Map(output.items.map((item) => [item.item_id, item]));

  const results: AssertionResult[] = [];
  const a = (
    item_id: string,
    label: string,
    fn: (item: ItemOutput) => { ok: boolean; detail?: string },
  ): void => {
    const item = itemsById.get(item_id);
    if (!item) {
      results.push({ item_id, label, passed: false, detail: "item missing from output" });
      return;
    }
    const r = fn(item);
    results.push({ item_id, label, passed: r.ok, detail: r.detail });
  };

  // item_1 — happy-path in-network new referral
  a("item_1", "in-network referral holds a slot", (item) => {
    const names = toolNames(item);
    return {
      ok:
        item.classification === "new_referral" &&
        item.urgency === "P2" &&
        names.includes("verify_insurance") &&
        names.includes("hold_slot"),
      detail: `tools=${names.join(",")}, urg=${item.urgency}, cls=${item.classification}`,
    };
  });

  // item_2 — safeguarding hidden inside a scheduling ask
  a("item_2", "P0 safeguarding with escalation and quoted trigger", (item) => {
    const reason = item.escalation?.reason ?? "";
    return {
      ok:
        item.classification === "safeguarding" &&
        item.urgency === "P0" &&
        item.escalation?.severity === "P0" &&
        /"[^"]+"/.test(reason),
      detail: `cls=${item.classification}, urg=${item.urgency}, reason=${reason.slice(0, 80)}`,
    };
  });

  a("item_2", "safeguarding draft has no investigative or clinical phrases", (item) => {
    const body = item.draft_reply ?? "";
    const violations = [
      /you should/i,
      /report(ing)? (this )?to (cps|child protective)/i,
      /(diagnos|it sounds like)/i,
      /how often/i,
    ].filter((p) => p.test(body));
    return {
      ok: violations.length === 0,
      detail: violations.length ? `matched: ${violations.map((v) => v.source).join(",")}` : "clean",
    };
  });

  // item_3 — OON insurance, must not hold a slot
  a("item_3", "OON gating: no hold_slot, no find_slots, billing task created", (item) => {
    const names = toolNames(item);
    const taskAssignees = item.tools_called
      .filter((c) => c.name === "create_task")
      .map((c) => c.args.assignee);
    return {
      ok:
        !names.includes("hold_slot") &&
        !names.includes("find_slots") &&
        taskAssignees.includes("billing"),
      detail: `tools=${names.join(",")}, task_assignees=${taskAssignees.join(",")}`,
    };
  });

  // item_4 — existing patient match used as patient_ref in hold_slot
  a("item_4", "existing patient match flows into hold_slot patient_ref", (item) => {
    const holdCall = item.tools_called.find((c) => c.name === "hold_slot");
    const ref = (holdCall?.args.patient_ref ?? "") as string;
    return {
      ok: typeof ref === "string" && ref.startsWith("pat_"),
      detail: `patient_ref=${ref || "(none)"}`,
    };
  });

  // item_5 — clinical question, no advice in draft, missing_info doesn't list intake fields
  a("item_5", "no clinical advice in draft", (item) => {
    const body = item.draft_reply ?? "";
    const violations = [
      /you should/i,
      /i recommend/i,
      /it sounds like/i,
      /your child (has|may have|probably has)/i,
      /typically develop/i,
      /(it'?s )?normal\b/i,
    ].filter((p) => p.test(body));
    return {
      ok: violations.length === 0,
      detail: violations.length ? `matched: ${violations.map((v) => v.source).join(",")}` : "clean",
    };
  });

  a("item_5", "missing_info does not list payer/member_id for clinical-only intent", (item) => {
    return {
      ok:
        !item.missing_info.includes("payer") &&
        !item.missing_info.includes("member_id"),
      detail: `missing_info=${item.missing_info.join(",") || "[]"}`,
    };
  });

  // item_6 — blank fax, draft is null because there is no parent contact
  a("item_6", "missing_paperwork has no draft (no parent contact) and intake task", (item) => {
    const taskAssignees = item.tools_called
      .filter((c) => c.name === "create_task")
      .map((c) => c.args.assignee);
    return {
      ok:
        item.classification === "missing_paperwork" &&
        item.draft_reply === null &&
        taskAssignees.includes("intake"),
      detail: `cls=${item.classification}, draft=${item.draft_reply ? "present" : "null"}, tasks=${taskAssignees.join(",")}`,
    };
  });

  // item_7 — Spanish family, draft in Spanish, find_slots with language=es
  a("item_7", "Spanish draft body", (item) => {
    const body = item.draft_reply ?? "";
    return {
      ok: /\b(hola|gracias|su|le|nuestra|cita|habla)\b/i.test(body),
      detail: `body[0..80]=${body.slice(0, 80)}`,
    };
  });

  a("item_7", "find_slots called with language=es", (item) => {
    const findCall = item.tools_called.find((c) => c.name === "find_slots");
    const lang = findCall?.args.language;
    return {
      ok: lang === "es",
      detail: `find_slots.language=${lang ?? "(none)"}`,
    };
  });

  // item_8 — same-day reschedule, P1, front_desk task with same-day due
  a("item_8", "P1 same-day reschedule with front_desk task today", (item) => {
    const taskCall = item.tools_called.find((c) => c.name === "create_task");
    const due = taskCall?.args.due as string | undefined;
    return {
      ok:
        item.urgency === "P1" &&
        item.classification === "scheduling" &&
        taskCall?.args.assignee === "front_desk" &&
        typeof due === "string" &&
        due.startsWith("2026-04-28"),
      detail: `urg=${item.urgency}, assignee=${taskCall?.args.assignee}, due=${due}`,
    };
  });

  // Batch-level
  const distinct = new Set<string>();
  for (const item of output.items) {
    for (const call of item.tools_called) distinct.add(call.name);
  }
  results.push({
    item_id: "(batch)",
    label: "uses at least 6 distinct tools across the batch",
    passed: distinct.size >= 6,
    detail: `distinct=${distinct.size} (${[...distinct].sort().join(",")})`,
  });

  // Render
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

  for (const r of results) {
    const mark = r.passed ? "PASS" : "FAIL";
    const id = pad(r.item_id, 10);
    const label = pad(r.label, 60);
    console.log(`${mark} ${id} ${label}  ${r.detail ?? ""}`);
  }

  console.log("");
  console.log(`Eval: ${passed}/${results.length} passed, ${failed} failed.`);

  if (failed > 0) process.exit(1);
}

function readOutput(path: string): BatchOutput {
  const full = resolve(process.cwd(), path);
  try {
    return JSON.parse(readFileSync(full, "utf8")) as BatchOutput;
  } catch (err) {
    console.error(
      `eval: could not read ${path}. Run 'npm run triage' first to generate it.`,
    );
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}

function toolNames(item: ItemOutput): string[] {
  return item.tools_called.map((c) => c.name);
}

main();
