import { describe, expect, it } from "vitest";
import { lintAndPrepareDraft, lintDraft } from "../src/draft.js";

const FALLBACK = "Thank you for your message. A team member will follow up shortly.";

describe("draft guardrails", () => {
  it("accepts a neutral acknowledgement", () => {
    const body =
      "Hi Daniel, thank you for the referral. Our intake team will follow up shortly to confirm a time.";
    const report = lintDraft(body);
    expect(report.ok).toBe(true);
    expect(lintAndPrepareDraft(body, { kind: "ack", fallback: FALLBACK, language: "en" })).toBe(body);
  });

  it("rejects 'we have sent' implied-action language", () => {
    const body = "Hi, we have emailed you the new appointment time.";
    const report = lintDraft(body);
    expect(report.ok).toBe(false);
    expect(report.violations).toContain("implied-sent");
  });

  it("rejects clinical advice in the draft body", () => {
    const body =
      "Hi, it sounds like a speech delay. You should book an evaluation immediately.";
    const report = lintDraft(body);
    expect(report.ok).toBe(false);
    expect(report.violations).toContain("clinical-advice");
  });

  it("rejects investigative-advice phrasing in safeguarding context", () => {
    const body =
      "We are reporting this to CPS — please let us know how often this happens.";
    const report = lintDraft(body);
    expect(report.ok).toBe(false);
    expect(report.violations).toContain("investigative-advice");
  });

  it("substitutes the safe fallback when the draft is rejected", () => {
    const result = lintAndPrepareDraft(
      "Your appointment is booked for tomorrow at 3pm.",
      { kind: "scheduling_ack", fallback: FALLBACK, language: "en" },
    );
    expect(result).toBe(FALLBACK);
  });
});
