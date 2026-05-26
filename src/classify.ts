import type { Extraction } from "./extract.js";
import type { Classification, InboxItem, Urgency } from "./types.js";

export interface Decision {
  classification: Classification;
  urgency: Urgency;
  escalation: { reason: string; severity: "P0" | "P1" } | null;
  rationale_overrides: string[];
}

// Tighter pattern than the extractor fallback regex: requires "rough with" to
// be followed by a child pronoun, and rejects "rough housing"/"roughhouse".
const TIGHT_SAFEGUARDING =
  /\b(rough(?!\s*housing)\s+with\s+(her|him|me)|hits?\s+(her|him|me|the kid)|punche[ds]?|kick(s|ed)\s+(her|him|me)|abus(e|ive|ed)|neglect(ed|ing)?|hurts?\s+(her|him|me)|scared\s+of\s+(dad|mom|him|her)|dad\s+(started\s+)?getting\s+rough)\b/i;

const NEGATIVE_SAFEGUARDING =
  /\b(rough\s*housing|wrestling with (his|her) brother|sibling)\b/i;

export function decide(item: InboxItem, extraction: Extraction): Decision {
  const overrides: string[] = [];
  let classification = extraction.classification;
  let urgency = extraction.urgency_suggestion;

  const regexSafeguarding =
    TIGHT_SAFEGUARDING.test(item.body) &&
    !NEGATIVE_SAFEGUARDING.test(item.body);

  // Safety overlay: escalate to P0 ONLY when LLM AND regex agree. This guards
  // both directions — LLM false negative (missed signal) AND LLM false positive
  // (over-escalation). The README explicitly warns over-escalation is itself
  // a production failure.
  if (regexSafeguarding && extraction.signals.safeguarding) {
    if (classification !== "safeguarding") {
      overrides.push(
        `Forced classification=safeguarding (both LLM and regex matched safeguarding signal; was ${classification})`,
      );
      classification = "safeguarding";
    }
    if (urgency !== "P0") {
      overrides.push(`Forced urgency=P0 (safeguarding); was ${urgency}`);
      urgency = "P0";
    }
  } else if (regexSafeguarding && !extraction.signals.safeguarding) {
    overrides.push(
      "Regex matched safeguarding language but LLM did not flag it — promoted to human review without auto-escalation. Clinical lead task created.",
    );
    if (classification !== "safeguarding") {
      classification = "safeguarding";
    }
    if (urgency === "P2" || urgency === "P3") {
      urgency = "P1";
      overrides.push(
        "Set urgency=P1 (ambiguous safeguarding signal, prompt human review without full P0 escalation)",
      );
    }
  } else if (!regexSafeguarding && extraction.signals.safeguarding) {
    // LLM said yes but the deterministic check didn't agree. Don't auto-P0;
    // keep human review but ask the clinical lead to look. This avoids the
    // over-escalation failure mode.
    overrides.push(
      "LLM flagged safeguarding but deterministic regex did not — downgraded from P0 to P1 to avoid over-escalation; clinical lead still notified.",
    );
    if (urgency === "P0") urgency = "P1";
    classification = "safeguarding";
  }

  // Same-day operational issue → P1 (unless already P0).
  if (urgency !== "P0" && extraction.signals.same_day_op) {
    if (urgency !== "P1") {
      overrides.push(
        `Forced urgency=P1 (same-day operational issue); was ${urgency}`,
      );
      urgency = "P1";
    }
    if (
      classification !== "scheduling" &&
      classification !== "existing_patient_request" &&
      classification !== "complaint"
    ) {
      classification = "scheduling";
      overrides.push(
        "Forced classification=scheduling (same-day op signal without alternative classification)",
      );
    }
  }

  // OON insurance can never have urgency higher than P2 just because of payer.
  // (Defensive — LLM occasionally over-rates billing issues.)
  if (
    extraction.signals.oon_hint &&
    !extraction.signals.safeguarding &&
    !extraction.signals.same_day_op &&
    (urgency === "P0" || urgency === "P1")
  ) {
    overrides.push(
      `Downgraded urgency from ${urgency} to P2 (OON payer alone is not an emergency).`,
    );
    urgency = "P2";
  }

  // Default floor: never go below P2 if it's a real intake item (anything with
  // child info present) — keeps it on the human review queue.
  const hasIntake =
    extraction.extracted_intake.child_name ||
    extraction.extracted_intake.discipline;
  if (urgency === "P3" && hasIntake) {
    overrides.push("Floored urgency to P2 (item has intake content).");
    urgency = "P2";
  }

  const escalation =
    urgency === "P0" || classification === "safeguarding"
      ? {
          reason: buildEscalationReason(item, extraction, classification),
          severity:
            (urgency === "P0" ? "P0" : "P1") as "P0" | "P1",
        }
      : urgency === "P1" && extraction.signals.same_day_op
        ? null // P1 same-day handled by tasks, no formal escalation needed
        : null;

  return {
    classification,
    urgency,
    escalation,
    rationale_overrides: overrides,
  };
}

function buildEscalationReason(
  item: InboxItem,
  extraction: Extraction,
  classification: Classification,
): string {
  if (classification === "safeguarding") {
    return `Possible safeguarding disclosure in ${item.channel} from ${item.sender}. Clinical lead must review within the hour; do not respond to the family with anything beyond a neutral acknowledgement.`;
  }
  return `Urgent triage issue on ${item.id}: ${extraction.reasoning}`;
}
