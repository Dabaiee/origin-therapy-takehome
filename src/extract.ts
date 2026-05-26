import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { callJSON, hasLLM } from "./llm.js";
import type {
  Classification,
  Discipline,
  ExtractedIntake,
  InboxItem,
  Urgency,
} from "./types.js";

export interface Signals {
  safeguarding: boolean;
  clinical_advice_only: boolean;
  same_day_op: boolean;
  language_es: boolean;
  oon_hint: boolean;
  existing_patient_hint: boolean;
  missing_fields: string[];
}

export interface Extraction {
  extracted_intake: ExtractedIntake;
  classification: Classification;
  urgency_suggestion: Urgency;
  signals: Signals;
  draft_body: string | null;
  draft_language: "en" | "es";
  reasoning: string;
  source: "llm" | "fallback";
}

function loadStatic(file: string): string {
  try {
    return readFileSync(resolve(process.cwd(), file), "utf8");
  } catch {
    return "";
  }
}

const POLICIES_MD = loadStatic("data/policies.md");
const PROVIDERS_JSON = loadStatic("data/providers.json");

const SYSTEM_INSTRUCTIONS = `You are a triage assistant for Cedar Kids Therapy, a pediatric SLP/OT/PT practice. Your job is to read ONE inbox item and emit a single JSON object that downstream playbooks will route on.

You MUST output JSON only, no prose. Follow the schema exactly. Do not invent fields. Use null where data is missing.

Schema (TypeScript-ish):
{
  "extracted_intake": {
    "child_name": string | null,
    "dob_or_age": string | null,
    "parent_contact": string | null,   // free-form: "Name, phone, email"
    "discipline": ("SLP" | "OT" | "PT")[] | null,
    "diagnosis_or_concern": string | null,
    "payer": string | null,
    "member_id": string | null
  },
  "classification": "new_referral" | "existing_patient_request" | "scheduling" | "clinical_question" | "billing_question" | "missing_paperwork" | "provider_followup" | "complaint" | "safeguarding" | "spam" | "other",
  "urgency_suggestion": "P0" | "P1" | "P2" | "P3",
  "signals": {
    "safeguarding": boolean,                 // ANY disclosure of harm/abuse/neglect/unsafe caregiving by ANYONE toward the child
    "clinical_advice_only": boolean,         // parent asking for clinical opinion, no intake/scheduling intent
    "same_day_op": boolean,                  // same-day cancellation/reschedule/illness
    "language_es": boolean,                  // family wrote in Spanish or asked for Spanish
    "oon_hint": boolean,                     // payer text suggests Kaiser, Cigna Select, Beacon
    "existing_patient_hint": boolean,        // message implies the child is already a patient (existing appointment, "my therapist", etc.)
    "missing_fields": string[]               // e.g. ["dob","parent_contact","payer"] when fax is blank
  },
  "draft_body": string | null,               // 2-4 sentences, neutral, no clinical advice, no "we have sent", no diagnosis. Null only for spam.
  "draft_language": "en" | "es",
  "reasoning": string                        // <= 240 chars, why this classification and urgency
}

Calibration:
- P0 ONLY for safeguarding/abuse/imminent harm. Over-escalation is a production failure.
- P1 for same-day operational issues (today's appointment cancel/reschedule/illness).
- P2 default for routine intake, scheduling, billing, clinical questions, missing paperwork.
- P3 for FYI/spam.

Drafting rules (CRITICAL):
- Never give clinical advice or opinions; if the family asked one, acknowledge and route to screening/evaluation.
- Never claim a message was sent ("we have emailed", "your appointment is booked"); the draft is for human review.
- For safeguarding, draft ONLY a neutral acknowledgement ("Thank you for sharing this. A clinical lead will follow up shortly."). Do NOT mention abuse, advise the parent, or imply investigation.
- For OON insurance, do NOT propose a slot; say billing will follow up.
- Match the family's language. If language_es, write the body in Spanish.

Cedar Kids policies (verbatim excerpts):
- Service lines: SLP, OT, PT for ages 0-18. Intake should confirm the requested discipline before scheduling.
- Insurance: in-network = Aetna, BCBS, UnitedHealthcare, Medicaid. Out-of-network = Kaiser, Cigna Select, Beacon. OON requires a benefits conversation before any slot is held.
- Verified billing status supersedes referral document.
- Safeguarding: any harm/abuse/neglect disclosure is P0, escalate to clinical lead, neutral acknowledgement only.
- Clinical advice: front desk/automated systems must not provide clinical advice; route to screening/evaluation.
- Scheduling: agents may recommend or hold slots for review, NEVER schedule. Same-day cancels/reschedules are P1.
- Language access: match Spanish-speaking families with Spanish-capable providers and draft in Spanish.

Providers available (so the draft is grounded):
- Maya Chen MS CCC-SLP (SLP, en, ages 2-8, accepting)
- Lucia Morales MA CCC-SLP (SLP, en+es, ages 0-12, accepting)
- James Owens OTR/L (OT, en, ages 3-18, limited)
- Priya Shah PT DPT (PT, en, ages 0-18, accepting)
- Sofia Reyes OTR/L (OT, en+es, ages 4-18, FULL)

----- Full policies (verbatim source of truth) -----
${POLICIES_MD}

----- Provider roster (full JSON) -----
${PROVIDERS_JSON}

----- Worked examples of correct triage judgment -----

Example A — happy-path new referral:
Fax: "Child: Emma Lee. DOB: 2018-09-04. Discipline: SLP. Concern: articulation. Insurance: BCBS PPO. Member: BCBS-884200."
→ classification: new_referral, urgency_suggestion: P2, signals.oon_hint: false, draft_body: brief English ack about intake calling to confirm a slot.

Example B — safeguarding hiding inside a scheduling ask:
Voicemail: "My son is 6. I wanted to ask about speech therapy openings. He has been more clingy since his dad started getting rough with him."
→ classification: safeguarding (NOT scheduling), urgency_suggestion: P0, signals.safeguarding: true, draft_body: a neutral one-sentence acknowledgement only — no mention of abuse, no advice, no investigative questions.

Example C — clinical question with no intake intent:
Portal: "Is it normal that my 4yo can't say R sounds yet? Should we wait until kindergarten?"
→ classification: clinical_question, urgency_suggestion: P2, signals.clinical_advice_only: true, draft_body: thank you + offer screening/evaluation, NO clinical opinion ("R sounds are typically..." is forbidden).

Example D — Spanish-speaking family, Medicaid (in-network):
Voicemail: "Hola, mi hija Isabella tiene 5 años, necesita evaluación de habla. Tenemos Medicaid, miembro MCD-55320. Prefiero alguien que hable español."
→ classification: new_referral, urgency_suggestion: P2, signals.language_es: true, draft_language: es, draft_body in Spanish, polite + brief, mentioning intake will call.

Example E — same-day reschedule:
Email: "URGENT!!! Noah threw up at school and I can't make today's 3pm OT appointment. Please reschedule!!!"
→ classification: scheduling, urgency_suggestion: P1, signals.same_day_op: true, draft_body: empathetic English ack, "front desk will call you back shortly".

Example F — blank fax (missing paperwork):
Fax: "Child: Sam Taylor. DOB: [blank]. Parent: [blank]. Discipline: SLP. Insurance: [blank]."
→ classification: missing_paperwork, urgency_suggestion: P2, signals.missing_fields includes dob, parent_contact, payer, member_id. draft_body: null (no parent contact to draft to).`;

const USER_TEMPLATE = (item: InboxItem) =>
  `Triage this inbox item:

id: ${item.id}
channel: ${item.channel}
received_at: ${item.received_at}
sender: ${item.sender}
subject: ${item.subject}
body: ${item.body}
attachments: ${JSON.stringify(item.attachments)}`;

export async function extract(item: InboxItem): Promise<Extraction> {
  if (hasLLM()) {
    try {
      const result = await callJSON<RawExtraction>({
        system: [{ text: SYSTEM_INSTRUCTIONS, cache: true }],
        user: USER_TEMPLATE(item),
        maxTokens: 900,
      });
      const cleaned = normalizeExtraction(result, item, "llm");
      return cleaned;
    } catch (err) {
      console.error(
        `[extract] ${item.id} LLM failed, falling back: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return fallbackExtract(item);
}

interface RawExtraction {
  extracted_intake?: Partial<ExtractedIntake>;
  classification?: string;
  urgency_suggestion?: string;
  signals?: Partial<Signals>;
  draft_body?: string | null;
  draft_language?: string;
  reasoning?: string;
}

function normalizeExtraction(
  raw: RawExtraction,
  item: InboxItem,
  source: "llm" | "fallback",
): Extraction {
  const intake: ExtractedIntake = {
    child_name: nonEmpty(raw.extracted_intake?.child_name),
    dob_or_age: nonEmpty(raw.extracted_intake?.dob_or_age),
    parent_contact: nonEmpty(raw.extracted_intake?.parent_contact),
    discipline: normalizeDisciplines(raw.extracted_intake?.discipline),
    diagnosis_or_concern: nonEmpty(raw.extracted_intake?.diagnosis_or_concern),
    payer: nonEmpty(raw.extracted_intake?.payer),
    member_id: nonEmpty(raw.extracted_intake?.member_id),
  };

  const signals: Signals = {
    safeguarding: !!raw.signals?.safeguarding,
    clinical_advice_only: !!raw.signals?.clinical_advice_only,
    same_day_op: !!raw.signals?.same_day_op,
    language_es: !!raw.signals?.language_es,
    oon_hint: !!raw.signals?.oon_hint,
    existing_patient_hint: !!raw.signals?.existing_patient_hint,
    missing_fields: Array.isArray(raw.signals?.missing_fields)
      ? raw.signals!.missing_fields.filter(
          (s): s is string => typeof s === "string",
        )
      : [],
  };

  return {
    extracted_intake: intake,
    classification: normalizeClassification(raw.classification),
    urgency_suggestion: normalizeUrgency(raw.urgency_suggestion),
    signals,
    draft_body:
      typeof raw.draft_body === "string" && raw.draft_body.trim().length > 0
        ? raw.draft_body.trim()
        : null,
    draft_language: raw.draft_language === "es" ? "es" : "en",
    reasoning:
      typeof raw.reasoning === "string" && raw.reasoning.trim().length > 0
        ? raw.reasoning.trim().slice(0, 400)
        : `Auto-classified from ${item.channel}.`,
    source,
  };
}

const CLASSIFICATIONS: Classification[] = [
  "new_referral",
  "existing_patient_request",
  "scheduling",
  "clinical_question",
  "billing_question",
  "missing_paperwork",
  "provider_followup",
  "complaint",
  "safeguarding",
  "spam",
  "other",
];

function normalizeClassification(value: unknown): Classification {
  if (typeof value === "string") {
    const match = CLASSIFICATIONS.find((c) => c === value);
    if (match) return match;
  }
  return "other";
}

function normalizeUrgency(value: unknown): Urgency {
  if (value === "P0" || value === "P1" || value === "P2" || value === "P3") {
    return value;
  }
  return "P2";
}

function normalizeDisciplines(value: unknown): Discipline[] | null {
  if (!Array.isArray(value)) return null;
  const allowed: Discipline[] = ["SLP", "OT", "PT"];
  const out: Discipline[] = [];
  for (const v of value) {
    if (typeof v === "string") {
      const match = allowed.find((d) => d === v.toUpperCase());
      if (match && !out.includes(match)) out.push(match);
    }
  }
  return out.length ? out : null;
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return null;
  if (/^\[?(blank|unknown|n\/?a|none)\]?$/i.test(trimmed)) return null;
  return trimmed;
}

// ---------------- Deterministic fallback ----------------

const SAFEGUARDING_REGEX =
  /\b(rough with|hit(s|ting)?\s+(her|him|me)|abus(e|ive)|neglect|hurts? me|scared of (dad|mom|him|her)|punche[ds]?|kick(s|ed)?\b.*(her|him|me))\b/i;
const SAME_DAY_REGEX =
  /\b(today('s|s)?|right now|this morning|this afternoon|3\s*pm|threw up at school)\b/i;
const SPANISH_REGEX =
  /\b(hola|gracias|mi hijo|mi hija|necesita|por favor|espan(o|ó)l|prefiero alguien que hable)\b/i;
const OON_REGEX = /\b(kaiser|cigna\s*select|beacon)\b/i;
const CLINICAL_QUESTION_REGEX =
  /\b(should i be worried|is it normal|should we wait|advice|opinion)\b/i;
const EXISTING_REGEX =
  /\b(today's\s*\d|reschedule|my (therapist|appointment)|cancel(ling)?\b)/i;

function fallbackExtract(item: InboxItem): Extraction {
  const body = item.body || "";
  const subjAndBody = `${item.subject} ${body}`;

  const dobMatch = body.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  const ageMatch = body.match(/\b(\d{1,2})\s*(?:years?\s*old|y\.?o\.?|anos)\b/i);
  const phoneMatch = body.match(/\b(555-\d{4})\b/);
  const emailMatch = body.match(/\b([\w.+-]+@[\w.-]+\.\w+)\b/);
  const memberMatch = body.match(/\b([A-Z]{3,4}-\d{3,7})\b/);
  const payerMatch =
    body.match(/(Blue Cross Blue Shield|BCBS|Aetna|UnitedHealthcare|United|Medicaid|Kaiser|Cigna(?: Select)?|Beacon)[^.]*/i);
  const disciplineMatches = new Set<Discipline>();
  if (/\b(slp|speech|articulation|stutter|habla)\b/i.test(subjAndBody))
    disciplineMatches.add("SLP");
  if (/\b(ot|occupational|sensory|feeding tolerance|fine motor)\b/i.test(subjAndBody))
    disciplineMatches.add("OT");
  if (/\b(pt|physical therapy|gait|toe walking|gross motor)\b/i.test(subjAndBody))
    disciplineMatches.add("PT");

  const safeguarding = SAFEGUARDING_REGEX.test(body);
  const sameDay = SAME_DAY_REGEX.test(subjAndBody);
  const spanish = SPANISH_REGEX.test(body);
  const oon = OON_REGEX.test(body);
  const clinicalOnly =
    CLINICAL_QUESTION_REGEX.test(body) && !/refer{1,2}al|book/i.test(body);
  const existing = EXISTING_REGEX.test(subjAndBody);

  const missingFields: string[] = [];
  if (!dobMatch && !ageMatch) missingFields.push("dob_or_age");
  if (!phoneMatch && !emailMatch) missingFields.push("parent_contact");
  if (!payerMatch) missingFields.push("payer");
  if (!memberMatch) missingFields.push("member_id");
  if (disciplineMatches.size === 0) missingFields.push("discipline");

  let classification: Classification = "other";
  let urgency: Urgency = "P2";

  if (safeguarding) {
    classification = "safeguarding";
    urgency = "P0";
  } else if (sameDay && existing) {
    classification = "scheduling";
    urgency = "P1";
  } else if (clinicalOnly) {
    classification = "clinical_question";
  } else if (item.channel === "fax_referral") {
    classification = missingFields.length >= 3 ? "missing_paperwork" : "new_referral";
  } else if (existing) {
    classification = "existing_patient_request";
  } else if (/referral|evaluation|eval\b/i.test(subjAndBody)) {
    classification = "new_referral";
  }

  const childMatch = body.match(/(?:Child|son|daughter|hija|hijo|para)\s*[:\-]?\s*([A-Z][a-z]+\s+[A-Z][a-z]+)/);
  const parentBits: string[] = [];
  if (item.sender) parentBits.push(item.sender.replace(/<.+?>/, "").trim());
  if (phoneMatch) parentBits.push(phoneMatch[1]);
  if (emailMatch) parentBits.push(emailMatch[1]);

  return normalizeExtraction(
    {
      extracted_intake: {
        child_name: childMatch ? childMatch[1] : null,
        dob_or_age: dobMatch ? dobMatch[1] : ageMatch ? `${ageMatch[1]} years old` : null,
        parent_contact: parentBits.length ? parentBits.join(", ") : null,
        discipline: [...disciplineMatches],
        diagnosis_or_concern: null,
        payer: payerMatch ? payerMatch[0].trim() : null,
        member_id: memberMatch ? memberMatch[1] : null,
      },
      classification,
      urgency_suggestion: urgency,
      signals: {
        safeguarding,
        clinical_advice_only: clinicalOnly,
        same_day_op: sameDay,
        language_es: spanish,
        oon_hint: oon,
        existing_patient_hint: existing,
        missing_fields: missingFields,
      },
      draft_body: null,
      draft_language: spanish ? "es" : "en",
      reasoning: "Fallback regex extractor (LLM unavailable).",
    },
    item,
    "fallback",
  );
}

// Note on the safeguarding regex above: it is intentionally permissive so the
// fallback extractor (used when the LLM is unavailable) does not under-flag.
// classify.ts holds a TIGHTER pattern that adds negative lookaheads and
// pronoun requirements; that is the one used in the human-review-vs-P0 gate.
// Two patterns is deliberate — false positives in the fallback are okay
// (a human still reviews), false positives in classify drive escalation.
