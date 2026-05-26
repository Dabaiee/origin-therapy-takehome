import {
  create_task,
  draft_message,
  escalate,
  find_slots,
  hold_slot,
  lookup_policy,
  search_patient,
  verify_insurance,
} from "./tools.js";
import { lintAndPrepareDraft } from "./draft.js";
import type { Decision } from "./classify.js";
import type { Extraction } from "./extract.js";
import type {
  Assignee,
  Discipline,
  InboxItem,
  ItemOutput,
  PolicyTopic,
  Slot,
} from "./types.js";

export interface PlaybookOutcome {
  task_ids: string[];
  missing_info: string[];
  recommended_next_action: string;
  draft_reply: string | null;
  decision_extras: string[];
}

export async function runPlaybook(
  item: InboxItem,
  extraction: Extraction,
  decision: Decision,
): Promise<PlaybookOutcome> {
  const ctx: PlaybookContext = {
    item,
    extraction,
    decision,
    task_ids: [],
    missing_info: extraction.signals.missing_fields.slice(),
    decision_extras: [],
  };

  switch (decision.classification) {
    case "safeguarding":
      return await safeguardingPlaybook(ctx);
    case "clinical_question":
      return await clinicalQuestionPlaybook(ctx);
    case "missing_paperwork":
      return await missingPaperworkPlaybook(ctx);
    case "scheduling":
      return await schedulingPlaybook(ctx);
    case "existing_patient_request":
      return await existingPatientPlaybook(ctx);
    case "new_referral":
      return await newReferralPlaybook(ctx);
    case "billing_question":
      return await billingQuestionPlaybook(ctx);
    case "provider_followup":
    case "complaint":
    case "spam":
    case "other":
    default:
      return await fallbackPlaybook(ctx);
  }
}

interface PlaybookContext {
  item: InboxItem;
  extraction: Extraction;
  decision: Decision;
  task_ids: string[];
  missing_info: string[];
  decision_extras: string[];
}

// ---------------- Safeguarding (P0) ----------------

async function safeguardingPlaybook(
  ctx: PlaybookContext,
): Promise<PlaybookOutcome> {
  await lookup_policy({ topic: "safeguarding" });

  if (ctx.decision.escalation) {
    await escalate({
      item_id: ctx.item.id,
      reason: ctx.decision.escalation.reason,
      severity: ctx.decision.escalation.severity,
    });
  }

  const task = await create_task({
    assignee: "clinical_lead",
    title: `Same-hour review: possible safeguarding disclosure (${ctx.item.id})`,
    due: sameDayDue(ctx.item),
    notes:
      "Review the inbox item for harm/abuse/neglect signals. Do not respond to family with anything beyond a neutral acknowledgement. Follow Cedar Kids safeguarding policy.",
  });
  ctx.task_ids.push(task.data.task_id);

  // Safety-critical: ALWAYS replace LLM draft with the fixed template.
  const safeBody = neutralAcknowledgement(
    ctx.extraction.draft_language,
    ctx.extraction.extracted_intake.child_name,
  );

  const channel = preferredReplyChannel(ctx.item);
  const recipient = bestRecipient(ctx);
  if (recipient) {
    await draft_message({
      recipient,
      channel,
      body: safeBody,
      language: ctx.extraction.draft_language,
    });
  }

  return {
    task_ids: ctx.task_ids,
    missing_info: ctx.missing_info,
    recommended_next_action:
      "Clinical lead must review within the hour. Front desk should not respond beyond the neutral acknowledgement draft.",
    draft_reply: recipient ? safeBody : null,
    decision_extras: ctx.decision.rationale_overrides,
  };
}

// ---------------- Clinical question (no advice) ----------------

async function clinicalQuestionPlaybook(
  ctx: PlaybookContext,
): Promise<PlaybookOutcome> {
  await lookup_policy({ topic: "clinical_advice" });
  const task = await create_task({
    assignee: "intake",
    title: `Clinical question from ${ctx.item.sender} — route to screening`,
    due: nextBusinessDayDue(ctx.item),
    notes:
      "Parent asked a clinical question. Do not provide an opinion in writing. Offer a screening call or evaluation slot per service-lines policy.",
  });
  ctx.task_ids.push(task.data.task_id);

  const draft = await produceDraft(
    ctx,
    "clinical_acknowledgement",
    "Thank you for reaching out. Our front desk cannot offer clinical opinions over message, but our intake team can set up a brief screening or evaluation to take a closer look. A staff member will follow up to walk you through next steps.",
  );

  return {
    task_ids: ctx.task_ids,
    missing_info: ctx.missing_info,
    recommended_next_action:
      "Intake should call or message the family to offer a screening/evaluation. Do not provide clinical advice in writing.",
    draft_reply: draft,
    decision_extras: ctx.decision.rationale_overrides,
  };
}

// ---------------- Missing paperwork ----------------

async function missingPaperworkPlaybook(
  ctx: PlaybookContext,
): Promise<PlaybookOutcome> {
  await lookup_policy({ topic: "service_lines" });
  const task = await create_task({
    assignee: "intake",
    title: `Incomplete referral — request missing info from referring office`,
    due: nextBusinessDayDue(ctx.item),
    notes: `Referral for ${
      ctx.extraction.extracted_intake.child_name || "(unnamed child)"
    } is missing: ${ctx.missing_info.join(", ") || "key fields"}. Call referring office to backfill before scheduling.`,
  });
  ctx.task_ids.push(task.data.task_id);

  return {
    task_ids: ctx.task_ids,
    missing_info: ctx.missing_info,
    recommended_next_action:
      "Intake should call the referring office to obtain DOB, guardian contact, and insurance details before scheduling.",
    draft_reply: null,
    decision_extras: ctx.decision.rationale_overrides,
  };
}

// ---------------- Scheduling (incl. same-day cancel) ----------------

async function schedulingPlaybook(
  ctx: PlaybookContext,
): Promise<PlaybookOutcome> {
  await lookup_policy({ topic: "cancellation" });

  // If we can match to an existing patient, do so (good audit).
  await tryPatientMatch(ctx);

  const task = await create_task({
    assignee: "front_desk",
    title: ctx.extraction.signals.same_day_op
      ? `Same-day reschedule for ${
          ctx.extraction.extracted_intake.child_name || ctx.item.sender
        }`
      : `Scheduling request from ${ctx.item.sender}`,
    due: sameDayDue(ctx.item),
    notes:
      "Call family to confirm reschedule preference. Check provider availability and offer next openings; do NOT auto-schedule.",
  });
  ctx.task_ids.push(task.data.task_id);

  const draft = await produceDraft(
    ctx,
    "scheduling_ack",
    ctx.extraction.signals.same_day_op
      ? `Hi ${friendlyName(ctx)}, thank you for letting us know. We've flagged today's appointment for our front desk to reach out about rescheduling. A team member will call you back shortly to find a new time that works.`
      : `Hi ${friendlyName(ctx)}, thank you for the scheduling request. Our front desk will reach out shortly to find a time that works for your family.`,
  );

  return {
    task_ids: ctx.task_ids,
    missing_info: ctx.missing_info,
    recommended_next_action:
      "Front desk should call the family to confirm a new time within today. No appointment is held until staff confirms.",
    draft_reply: draft,
    decision_extras: ctx.decision.rationale_overrides,
  };
}

// ---------------- Existing patient (non same-day) ----------------

async function existingPatientPlaybook(
  ctx: PlaybookContext,
): Promise<PlaybookOutcome> {
  await tryPatientMatch(ctx);
  const task = await create_task({
    assignee: "front_desk",
    title: `Existing-patient request from ${ctx.item.sender}`,
    due: nextBusinessDayDue(ctx.item),
    notes: "Pull up patient chart, confirm intent, follow up by preferred channel.",
  });
  ctx.task_ids.push(task.data.task_id);

  const draft = await produceDraft(
    ctx,
    "existing_ack",
    `Hi ${friendlyName(ctx)}, thank you for your message. We've routed this to our front desk and a team member will follow up with you shortly.`,
  );

  return {
    task_ids: ctx.task_ids,
    missing_info: ctx.missing_info,
    recommended_next_action:
      "Front desk to follow up with the family by their preferred channel.",
    draft_reply: draft,
    decision_extras: ctx.decision.rationale_overrides,
  };
}

// ---------------- New referral (the main flow) ----------------

async function newReferralPlaybook(
  ctx: PlaybookContext,
): Promise<PlaybookOutcome> {
  await lookup_policy({ topic: "service_lines" });

  // Patient search (in case the "new" referral is actually a re-referral).
  const patient = await tryPatientMatch(ctx);

  // Insurance verification — gates whether we can hold a slot.
  const payer = ctx.extraction.extracted_intake.payer || undefined;
  const memberId = ctx.extraction.extracted_intake.member_id || undefined;
  let insuranceStatus: string | null = null;
  if (payer) {
    const ins = await verify_insurance({ payer, member_id: memberId });
    insuranceStatus = ins.data.status;
    if (ins.data.status === "out_of_network" || ins.data.status === "expired") {
      return await oonReferralPath(ctx, ins.data.status);
    }
  } else {
    ctx.missing_info.push("payer");
  }

  // In-network or unknown but otherwise OK — propose a slot for human review.
  const disciplines = ctx.extraction.extracted_intake.discipline;
  const primaryDiscipline = disciplines?.[0];
  let slot: Slot | null = null;
  if (primaryDiscipline) {
    const slots = await find_slots({
      discipline: primaryDiscipline,
      language: ctx.extraction.draft_language,
    });
    slot = slots.data[0] || null;
    if (slot) {
      const patientRef =
        patient?.patient_id ||
        (ctx.extraction.extracted_intake.child_name
          ? `prospective:${ctx.extraction.extracted_intake.child_name}`
          : `prospective:${ctx.item.id}`);
      await hold_slot({ slot_id: slot.slot_id, patient_ref: patientRef });
    }
  } else {
    ctx.missing_info.push("discipline");
  }

  const intakeTask = await create_task({
    assignee: "intake",
    title: `Confirm referral and slot for ${
      ctx.extraction.extracted_intake.child_name || "incoming child"
    }`,
    due: nextBusinessDayDue(ctx.item),
    notes: buildIntakeTaskNotes(ctx, insuranceStatus, slot, primaryDiscipline),
  });
  ctx.task_ids.push(intakeTask.data.task_id);

  const draft = await produceDraft(
    ctx,
    "new_referral_ack",
    buildReferralAckBody(ctx, slot),
  );

  return {
    task_ids: ctx.task_ids,
    missing_info: ctx.missing_info,
    recommended_next_action: slot
      ? `Intake to call family to confirm the held ${slot.start} ${slot.discipline} slot with ${slot.provider_name}, then convert hold to appointment after confirmation.`
      : "Intake to call family to gather missing intake details before recommending a slot.",
    draft_reply: draft,
    decision_extras: ctx.decision.rationale_overrides,
  };
}

async function oonReferralPath(
  ctx: PlaybookContext,
  status: "out_of_network" | "expired",
): Promise<PlaybookOutcome> {
  await lookup_policy({ topic: "insurance" });
  const billingTask = await create_task({
    assignee: "billing",
    title: `Benefits conversation for ${
      ctx.extraction.extracted_intake.child_name || ctx.item.sender
    } (${status === "expired" ? "expired coverage" : "out-of-network payer"})`,
    due: nextBusinessDayDue(ctx.item),
    notes: `Verified insurance status came back as ${status} for ${
      ctx.extraction.extracted_intake.payer || "(unknown payer)"
    }. Per policy, do NOT hold a slot until a benefits conversation has happened with the family. Call them to discuss options.`,
  });
  ctx.task_ids.push(billingTask.data.task_id);

  const draft = await produceDraft(
    ctx,
    "oon_ack",
    `Hi ${friendlyName(ctx)}, thank you for sending the referral. Before we move forward with scheduling, our billing team needs to review the insurance details on file — the plan may not be in network with Cedar Kids Therapy. A team member will reach out shortly to discuss options.`,
  );

  return {
    task_ids: ctx.task_ids,
    missing_info: ctx.missing_info,
    recommended_next_action:
      "Billing should call the family for a benefits conversation before any slot is offered.",
    draft_reply: draft,
    decision_extras: [
      ...ctx.decision.rationale_overrides,
      `Insurance verification returned ${status}; OON gating applied — no slot held.`,
    ],
  };
}

// ---------------- Billing question ----------------

async function billingQuestionPlaybook(
  ctx: PlaybookContext,
): Promise<PlaybookOutcome> {
  await lookup_policy({ topic: "insurance" });
  const task = await create_task({
    assignee: "billing",
    title: `Billing question from ${ctx.item.sender}`,
    due: nextBusinessDayDue(ctx.item),
    notes: "Review the family's question and respond per billing policy.",
  });
  ctx.task_ids.push(task.data.task_id);

  const draft = await produceDraft(
    ctx,
    "billing_ack",
    `Hi ${friendlyName(ctx)}, thank you for your message. Our billing team will review your question and get back to you shortly.`,
  );

  return {
    task_ids: ctx.task_ids,
    missing_info: ctx.missing_info,
    recommended_next_action:
      "Billing team to review and respond to the family.",
    draft_reply: draft,
    decision_extras: ctx.decision.rationale_overrides,
  };
}

// ---------------- Fallback (other/spam/complaint/provider_followup) ----------------

async function fallbackPlaybook(
  ctx: PlaybookContext,
): Promise<PlaybookOutcome> {
  const isSpam = ctx.decision.classification === "spam";
  const assignee: Assignee =
    ctx.decision.classification === "complaint" ? "clinical_lead" : "front_desk";

  await lookup_policy({ topic: "service_lines" });
  if (!isSpam) {
    const task = await create_task({
      assignee,
      title: `Triage follow-up for ${ctx.item.id} (${ctx.decision.classification})`,
      due: nextBusinessDayDue(ctx.item),
      notes:
        "Item did not match a routine playbook. Review and route appropriately.",
    });
    ctx.task_ids.push(task.data.task_id);
  }

  return {
    task_ids: ctx.task_ids,
    missing_info: ctx.missing_info,
    recommended_next_action: isSpam
      ? "Mark as spam and dismiss."
      : "Staff to review and route this item manually.",
    draft_reply: null,
    decision_extras: ctx.decision.rationale_overrides,
  };
}

// ---------------- Shared helpers ----------------

async function tryPatientMatch(ctx: PlaybookContext): Promise<{
  patient_id: string;
} | null> {
  const name = ctx.extraction.extracted_intake.child_name;
  const dob = ctx.extraction.extracted_intake.dob_or_age;
  if (!name) return null;
  const result = await search_patient({
    name,
    dob: dob && /^\d{4}-\d{2}-\d{2}$/.test(dob) ? dob : undefined,
  });
  if (result.data.length > 0) {
    return { patient_id: result.data[0].patient_id };
  }
  return null;
}

async function produceDraft(
  ctx: PlaybookContext,
  kind: string,
  template: string,
): Promise<string | null> {
  const recipient = bestRecipient(ctx);
  if (!recipient) return null;

  const candidateBody = ctx.extraction.draft_body || template;
  const linted = lintAndPrepareDraft(candidateBody, {
    kind,
    fallback: template,
    language: ctx.extraction.draft_language,
  });
  if (!linted) return null;

  const channel = preferredReplyChannel(ctx.item);
  await draft_message({
    recipient,
    channel,
    body: linted,
    language: ctx.extraction.draft_language,
  });
  return linted;
}

function preferredReplyChannel(item: InboxItem): "portal" | "email" | "phone" {
  if (item.channel === "portal_message") return "portal";
  if (item.channel === "email") return "email";
  return "phone"; // fax_referral and voicemail_transcript both follow up by phone
}

function bestRecipient(ctx: PlaybookContext): string | null {
  const contact = ctx.extraction.extracted_intake.parent_contact;
  if (contact) return contact;
  if (ctx.item.sender) return ctx.item.sender;
  return null;
}

function friendlyName(ctx: PlaybookContext): string {
  const contact = ctx.extraction.extracted_intake.parent_contact || ctx.item.sender;
  const m = contact.match(/^([A-Z][a-z]+)/);
  return m ? m[1] : "there";
}

function sameDayDue(item: InboxItem): string {
  const received = new Date(item.received_at);
  return received.toISOString().slice(0, 10);
}

function nextBusinessDayDue(item: InboxItem): string {
  const received = new Date(item.received_at);
  const next = new Date(received.getTime() + 24 * 60 * 60 * 1000);
  return next.toISOString().slice(0, 10);
}

function neutralAcknowledgement(
  language: "en" | "es",
  childName: string | null,
): string {
  if (language === "es") {
    return childName
      ? `Hola, gracias por su mensaje sobre ${childName}. Hemos compartido esto con nuestra líder clínica, quien se comunicará con usted pronto. Si necesita ayuda inmediata, por favor llame al 911.`
      : "Hola, gracias por su mensaje. Hemos compartido esto con nuestra líder clínica, quien se comunicará con usted pronto. Si necesita ayuda inmediata, por favor llame al 911.";
  }
  return childName
    ? `Hello, thank you for reaching out about ${childName}. We've shared your message with our clinical lead, who will follow up with you shortly. If you need immediate help, please call 911.`
    : "Hello, thank you for reaching out. We've shared your message with our clinical lead, who will follow up with you shortly. If you need immediate help, please call 911.";
}

function buildIntakeTaskNotes(
  ctx: PlaybookContext,
  insuranceStatus: string | null,
  slot: Slot | null,
  primaryDiscipline: Discipline | undefined,
): string {
  const lines: string[] = [];
  lines.push(
    `New referral: ${
      ctx.extraction.extracted_intake.child_name || "(name on referral)"
    }, ${
      ctx.extraction.extracted_intake.dob_or_age || "(dob unknown)"
    }, discipline ${primaryDiscipline || "?"}.`,
  );
  if (insuranceStatus) {
    lines.push(`Insurance verified ${insuranceStatus}.`);
  }
  if (slot) {
    lines.push(
      `Slot held for review: ${slot.start} with ${slot.provider_name}. Confirm with family before converting to appointment.`,
    );
  } else if (primaryDiscipline) {
    lines.push("No matching slot was held; call family to discuss timing.");
  }
  if (ctx.missing_info.length) {
    lines.push(`Missing info: ${ctx.missing_info.join(", ")}.`);
  }
  return lines.join(" ");
}

function buildReferralAckBody(
  ctx: PlaybookContext,
  slot: Slot | null,
): string {
  const name = friendlyName(ctx);
  if (slot) {
    return `Hi ${name}, thank you for the referral. We've put a tentative ${slot.discipline} hold on ${slot.start} with ${slot.provider_name} for our intake team to review. A team member will call you to confirm the time before anything is booked.`;
  }
  return `Hi ${name}, thank you for the referral. Our intake team will reach out shortly to gather a few details and find a time that works for your family.`;
}

// Re-export the policy topic helper so playbooks can call lookup_policy with a
// type-safe topic without re-importing the union.
export type { PolicyTopic, ItemOutput };
