import { describe, expect, it } from "vitest";
import { decide } from "../src/classify.js";
import type { Extraction } from "../src/extract.js";
import type { InboxItem } from "../src/types.js";

function makeItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "item_test",
    channel: "email",
    received_at: "2026-04-28T07:00:00-07:00",
    sender: "Test Sender <test@example.com>",
    subject: "Test",
    body: "body",
    attachments: [],
    ...overrides,
  };
}

function makeExtraction(overrides: Partial<Extraction> = {}): Extraction {
  return {
    extracted_intake: {
      child_name: null,
      dob_or_age: null,
      parent_contact: null,
      discipline: null,
      diagnosis_or_concern: null,
      payer: null,
      member_id: null,
    },
    classification: "other",
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

describe("classify.decide", () => {
  it("escalates to P0 when BOTH llm signal and regex match safeguarding", () => {
    const item = makeItem({
      body: "Hi, my son is 6, he has been more clingy since his dad started getting rough with him.",
    });
    const extraction = makeExtraction({
      classification: "scheduling",
      urgency_suggestion: "P2",
      signals: { ...makeExtraction().signals, safeguarding: true },
    });
    const decision = decide(item, extraction);
    expect(decision.classification).toBe("safeguarding");
    expect(decision.urgency).toBe("P0");
    expect(decision.escalation?.severity).toBe("P0");
  });

  it("does NOT escalate on benign 'rough housing' phrasing (no over-escalation)", () => {
    const item = makeItem({
      body: "He likes wrestling with his brother — they do rough housing all weekend.",
    });
    const extraction = makeExtraction({
      classification: "new_referral",
      urgency_suggestion: "P2",
      signals: { ...makeExtraction().signals, safeguarding: false },
    });
    const decision = decide(item, extraction);
    expect(decision.classification).toBe("new_referral");
    expect(decision.urgency).toBe("P2");
    expect(decision.escalation).toBeNull();
  });

  it("downgrades llm-only safeguarding flag to P1 instead of P0 (over-escalation guard)", () => {
    const item = makeItem({
      body: "Routine speech eval request, nothing alarming.",
    });
    const extraction = makeExtraction({
      classification: "new_referral",
      urgency_suggestion: "P0",
      signals: { ...makeExtraction().signals, safeguarding: true },
    });
    const decision = decide(item, extraction);
    expect(decision.urgency).toBe("P1");
    expect(decision.classification).toBe("safeguarding");
  });

  it("forces P1 for same-day operational items", () => {
    const item = makeItem({
      body: "Need to reschedule today's 3pm OT appointment.",
    });
    const extraction = makeExtraction({
      classification: "scheduling",
      urgency_suggestion: "P2",
      signals: { ...makeExtraction().signals, same_day_op: true },
    });
    const decision = decide(item, extraction);
    expect(decision.urgency).toBe("P1");
    expect(decision.classification).toBe("scheduling");
  });

  it("downgrades OON-only items to P2 (never P1 just because of payer)", () => {
    const item = makeItem({ body: "Kaiser HMO referral for OT eval." });
    const extraction = makeExtraction({
      classification: "new_referral",
      urgency_suggestion: "P1",
      signals: { ...makeExtraction().signals, oon_hint: true },
    });
    const decision = decide(item, extraction);
    expect(decision.urgency).toBe("P2");
  });

  it("defaults to P2 when no signals fire", () => {
    const item = makeItem({ body: "Standard referral for Emma." });
    const extraction = makeExtraction({
      classification: "new_referral",
      urgency_suggestion: "P2",
    });
    const decision = decide(item, extraction);
    expect(decision.urgency).toBe("P2");
    expect(decision.classification).toBe("new_referral");
    expect(decision.escalation).toBeNull();
  });
});
