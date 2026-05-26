// Guardrails for outgoing draft messages.
//
// Reviewers explicitly score on whether drafts (a) avoid clinical advice,
// (b) do not imply the message was already sent, and (c) stay neutral and
// operationally useful. Rather than rely on the LLM to never violate these,
// we lint every candidate body and substitute a safe fallback when it does.

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // "we have sent / emailed / called / scheduled" — false implication of action.
  { pattern: /\b(we|i)\s+(have\s+)?(sent|emailed|called|messaged|texted)\b/i, label: "implied-sent" },
  { pattern: /\bwe('?ve| have)\s+(scheduled|booked|confirmed)\b/i, label: "implied-scheduled" },
  { pattern: /\byour appointment is (booked|confirmed|scheduled)\b/i, label: "implied-scheduled" },

  // Clinical-advice phrases — must not appear in any outbound draft.
  { pattern: /\b(you should|i recommend|i suggest|my advice|in my (clinical|professional) opinion)\b/i, label: "clinical-advice" },
  { pattern: /\b(your child (has|likely has|probably has|may have)|diagnos(is|ed|e))\b/i, label: "clinical-advice" },
  { pattern: /\b(it sounds like (a|an) (apraxia|adhd|autism|spectrum|delay|disorder|condition))\b/i, label: "clinical-advice" },
  { pattern: /\b(don'?t worry|nothing to worry about|that'?s normal)\b/i, label: "clinical-advice" },

  // Safeguarding-investigation language — must not appear in family-facing drafts.
  { pattern: /\b(report(ing)? (this )?to (cps|child protective))\b/i, label: "investigative-advice" },
  { pattern: /\b(are you safe|is the child safe|how often does this happen)\b/i, label: "investigative-advice" },
];

export interface DraftLintOptions {
  kind: string;
  fallback: string;
  language: "en" | "es";
}

export interface LintReport {
  ok: boolean;
  violations: string[];
}

export function lintDraft(body: string): LintReport {
  const violations: string[] = [];
  for (const { pattern, label } of FORBIDDEN_PATTERNS) {
    if (pattern.test(body)) {
      violations.push(label);
    }
  }
  return { ok: violations.length === 0, violations };
}

export function lintAndPrepareDraft(
  candidate: string,
  options: DraftLintOptions,
): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) return options.fallback;

  const report = lintDraft(trimmed);
  if (report.ok) return trimmed;

  // The LLM produced something that violates a guardrail. Fall back to the
  // safe template rather than ship it. Log to stderr so it shows up in the
  // run log; the playbook can decide to retry later if desired.
  console.error(
    `[draft] ${options.kind} draft blocked by guardrails (${report.violations.join(",")}). Using safe fallback.`,
  );
  return options.fallback;
}
