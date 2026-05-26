import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Decision } from "../src/classify.js";
import type { Extraction } from "../src/extract.js";
import { runPlaybook } from "../src/playbooks.js";
import {
  configureTrace,
  getToolCallsForItem,
  withItemContext,
} from "../src/tools.js";
import type { InboxItem } from "../src/types.js";

function freshTrace(): void {
  const dir = mkdtempSync(join(tmpdir(), "trace-"));
  configureTrace({ path: join(dir, "tool-calls.jsonl") });
}

function makeItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "test_item",
    channel: "fax_referral",
    received_at: "2026-04-28T07:00:00-07:00",
    sender: "Test sender",
    subject: "Referral",
    body: "Test body",
    attachments: [],
    ...overrides,
  };
}

function makeExtraction(overrides: Partial<Extraction> = {}): Extraction {
  return {
    extracted_intake: {
      child_name: "Test Child",
      dob_or_age: "2020-01-01",
      parent_contact: "Test Parent, 555-0000",
      discipline: ["SLP"],
      diagnosis_or_concern: null,
      payer: null,
      member_id: null,
    },
    classification: "new_referral",
    urgency_suggestion: "P2",
    signals: {
      safeguarding: false,
      clinical_advice_only: false,
      same_day_op: false,
      language_es: false,
      oon_hint: false,
      existing_patient_hint: false,
      missing_fields: [],
    },
    draft_body: null,
    draft_language: "en",
    reasoning: "test",
    source: "llm",
    ...overrides,
  };
}

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    classification: "new_referral",
    urgency: "P2",
    escalation: null,
    rationale_overrides: [],
    ...overrides,
  };
}

describe("playbooks integration", () => {
  beforeEach(() => freshTrace());

  it("OON insurance branch never calls hold_slot or find_slots", async () => {
    const item = makeItem({ id: "test_oon" });
    const extraction = makeExtraction({
      extracted_intake: {
        child_name: "Owen Brooks",
        dob_or_age: "2020-02-11",
        parent_contact: "Rachel Brooks, 555-0103",
        discipline: ["OT"],
        diagnosis_or_concern: "sensory processing",
        payer: "Kaiser HMO",
        member_id: "KSR-4471",
      },
      signals: {
        ...makeExtraction().signals,
        oon_hint: true,
      },
    });
    const decision = makeDecision();

    await withItemContext(item.id, () =>
      runPlaybook(item, extraction, decision),
    );

    const names = getToolCallsForItem(item.id).map((c) => c.name);
    expect(names).toContain("verify_insurance");
    expect(names).toContain("create_task");
    expect(names).not.toContain("hold_slot");
    expect(names).not.toContain("find_slots");
  });

  it("in-network new referral calls find_slots and hold_slot", async () => {
    const item = makeItem({ id: "test_in_net" });
    const extraction = makeExtraction({
      extracted_intake: {
        child_name: "Emma Lee",
        dob_or_age: "2018-09-04",
        parent_contact: "Daniel Lee, 555-0101, daniel.lee@example.com",
        discipline: ["SLP"],
        diagnosis_or_concern: "articulation",
        payer: "Blue Cross Blue Shield PPO",
        member_id: "BCBS-884200",
      },
    });
    const decision = makeDecision();

    await withItemContext(item.id, () =>
      runPlaybook(item, extraction, decision),
    );

    const names = getToolCallsForItem(item.id).map((c) => c.name);
    expect(names).toContain("verify_insurance");
    expect(names).toContain("find_slots");
    expect(names).toContain("hold_slot");
    expect(names).toContain("create_task");
    expect(names).toContain("draft_message");
  });

  it("safeguarding playbook always escalates and creates a clinical_lead task", async () => {
    const item = makeItem({
      id: "test_safe",
      channel: "voicemail_transcript",
      body: "Test body",
    });
    const extraction = makeExtraction({
      classification: "safeguarding",
      signals: { ...makeExtraction().signals, safeguarding: true },
    });
    const decision = makeDecision({
      classification: "safeguarding",
      urgency: "P0",
      escalation: { reason: "Test safeguarding signal", severity: "P0" },
    });

    await withItemContext(item.id, () =>
      runPlaybook(item, extraction, decision),
    );

    const calls = getToolCallsForItem(item.id);
    const names = calls.map((c) => c.name);
    expect(names).toContain("escalate");
    expect(names).toContain("lookup_policy");
    expect(names).toContain("create_task");

    const taskCall = calls.find((c) => c.name === "create_task");
    expect(taskCall?.args.assignee).toBe("clinical_lead");
  });

  it("guardian-of-record mismatch blocks slot hold and routes to intake", async () => {
    // Mateo Ramirez Jr. is on file with guardian "Sofia Ramirez" (see
    // src/tools.ts search_patient stub). Carla Mendez claims to be the
    // parent — guardian-of-record mismatch must short-circuit the referral
    // flow before find_slots / hold_slot run, and the draft must not name
    // the child or reference the chart.
    const item = makeItem({
      id: "test_guardian_mismatch",
      channel: "email",
      sender: "Carla Mendez <carla.mendez@example.com>",
      body: "I am his parent...",
    });
    const extraction = makeExtraction({
      extracted_intake: {
        child_name: "Mateo Ramirez",
        dob_or_age: "2019-03-15",
        parent_contact: "Carla Mendez, 555-0104, carla.mendez@example.com",
        discipline: ["PT"],
        diagnosis_or_concern: "toe walking",
        payer: "Aetna PPO",
        member_id: "AET-9910",
      },
    });
    const decision = makeDecision();

    const outcome = await withItemContext(item.id, () =>
      runPlaybook(item, extraction, decision),
    );

    const calls = getToolCallsForItem(item.id);
    const names = calls.map((c) => c.name);
    expect(names).toContain("search_patient");
    expect(names).not.toContain("hold_slot");
    expect(names).not.toContain("find_slots");
    expect(names).not.toContain("verify_insurance");

    const taskCall = calls.find((c) => c.name === "create_task");
    expect(taskCall?.args.assignee).toBe("intake");
    expect(String(taskCall?.args.title)).toMatch(/identity verification/i);

    // Draft must be neutral: no child name, no chart references, no insurance.
    expect(outcome.draft_reply).not.toBeNull();
    expect(outcome.draft_reply).not.toMatch(/mateo/i);
    expect(outcome.draft_reply).not.toMatch(/ramirez/i);
    expect(outcome.draft_reply).not.toMatch(/slot|hold|appointment/i);
    expect(outcome.draft_reply).not.toMatch(/aetna|insurance|payer/i);
    expect(outcome.draft_reply).not.toMatch(/\bPT\b|\bOT\b|\bSLP\b/);
  });

  it("guardian-of-record match (sender == guardian) proceeds with normal referral flow", async () => {
    // Anita Patel is on file as guardian for Noah Patel (see tools.ts stub).
    // When she contacts about Noah, identity matches and the flow should
    // proceed normally — verify_insurance + find_slots + hold_slot all run.
    const item = makeItem({
      id: "test_guardian_match",
      channel: "email",
      sender: "Anita Patel <anita.patel@example.com>",
      body: "New OT referral for Noah",
    });
    const extraction = makeExtraction({
      extracted_intake: {
        child_name: "Noah Patel",
        dob_or_age: "2017-11-02",
        parent_contact: "Anita Patel, 555-0108, anita.patel@example.com",
        discipline: ["OT"],
        diagnosis_or_concern: "sensory",
        payer: "Aetna PPO",
        member_id: "AET-1111",
      },
    });
    const decision = makeDecision();

    await withItemContext(item.id, () =>
      runPlaybook(item, extraction, decision),
    );

    const names = getToolCallsForItem(item.id).map((c) => c.name);
    expect(names).toContain("search_patient");
    expect(names).toContain("verify_insurance");
    expect(names).toContain("find_slots");
    expect(names).toContain("hold_slot");
  });

  it("clinical question playbook does not provide clinical advice in the draft", async () => {
    const item = makeItem({
      id: "test_clinical",
      channel: "portal_message",
      sender: "Jordan Kim",
      body: "Should we wait for R sounds?",
    });
    const extraction = makeExtraction({
      classification: "clinical_question",
      signals: { ...makeExtraction().signals, clinical_advice_only: true },
      // LLM-suggested draft that smuggles in clinical advice — guardrail must
      // strip this and substitute a safe template.
      draft_body:
        "R sounds typically develop by age 6. You should wait until kindergarten.",
    });
    const decision = makeDecision({ classification: "clinical_question" });

    const outcome = await withItemContext(item.id, () =>
      runPlaybook(item, extraction, decision),
    );

    expect(outcome.draft_reply).not.toBeNull();
    expect(outcome.draft_reply).not.toMatch(/you should/i);
    expect(outcome.draft_reply).not.toMatch(/typically develop/i);
  });
});
