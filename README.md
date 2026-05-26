# Origin AI Engineering Take-Home: Referral Inbox Triage Agent

A pediatric-therapy referral-inbox triage agent for Cedar Kids Therapy. Reads
the Monday inbox (`data/inbox.json`), uses the provided audit-traced tools, and
writes a sorted, human-reviewable action plan to `output.json`.

## 1. How to run

```bash
npm install
cp .env.example .env       # paste ANTHROPIC_API_KEY=... into .env
npm run triage             # writes output.json + .trace/tool-calls.jsonl
npm run validate           # asserts output.json matches the schema and trace
npm run eval               # per-item expected-behavior assertions on output.json
npm test                   # 17 unit + integration tests on the safety-critical paths
npm run typecheck          # strict tsc, no emit
```

The `eval` script is what the README's "20 minutes self-evaluating against the
validator and the inbox" phase produced — see section 4 for the methodology.

Flags are optional and default to `--input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl`.

If `ANTHROPIC_API_KEY` is unset, the agent automatically falls back to a
deterministic regex-based extractor. The pipeline still produces a valid
`output.json` and `npm run validate` still passes — just with thinner intake
extraction and template-only draft bodies. This is intentional, so reviewers
without a key still get a runnable submission.

## 2. Stack and runtime

- **Language:** TypeScript (strict, NodeNext), Node 22 LTS, npm.
- **LLM:** Anthropic Opus 4.7 (`claude-opus-4-7`), one call per item, prompt
  caching enabled on the static system block.
- **Dependencies added:** `@anthropic-ai/sdk`, `dotenv`, `vitest`. Everything
  else was already in the starter pack.
- **Wall time:** ~14s for the 8-item inbox at concurrency 4.
- **Cost per batch (Opus 4.7, observed):** ~$0.33 cold, ~$0.05 of incremental
  input after the system prompt is cached (cache_read ≈ 16× cache_write).
- **No mocks for tool functions** — `src/tools.ts` is used unmodified so the
  audit trace at `.trace/tool-calls.jsonl` matches what the validator expects.

## 3. Architecture

Hybrid: the LLM does perception (extract structured intake + signals + a
candidate draft body); deterministic code does routing and enforces every
safety guarantee.

```
inbox item ─► [extract.ts]   1 LLM call (Opus 4.7), cached system prompt
                  │           returns: ExtractedIntake + classification
                  │                    + urgency_suggestion + signals
                  │                    + candidate draft_body + reasoning
                  ▼
              [classify.ts]  pure-function safety overlay
                  │           - P0 only when LLM+regex BOTH flag safeguarding
                  │           - P1 forced for same-day operational items
                  │           - OON payer alone never above P2 (anti-over-esc)
                  │           - "rough housing" negative-lookahead (anti-FP)
                  ▼
              [playbooks.ts] dispatch by classification
                  │           - safeguarding: lookup_policy → escalate
                  │                          → create_task(clinical_lead)
                  │                          → draft with FIXED neutral template
                  │           - new_referral: lookup_policy(service_lines)
                  │                          → search_patient → verify_insurance
                  │                          → (OON?) gate → find_slots
                  │                          → hold_slot → create_task → draft
                  │           - clinical_question: lookup_policy(clinical_advice)
                  │                          → create_task(intake) → draft
                  │           - missing_paperwork: lookup_policy → create_task
                  │           - scheduling (same-day): lookup_policy(cancellation)
                  │                          → search_patient
                  │                          → create_task(front_desk, today)
                  │                          → empathetic draft
                  │           - billing/existing/other/spam: minimal routes
                  │
                  │           every draft body passes through [draft.ts] which
                  │           lints for forbidden phrases (clinical advice,
                  │           "we have sent", investigative phrasing) and
                  │           substitutes a safe template on violation.
                  ▼
              [agent.ts]     orchestrator, concurrency=4, per-item error
                             containment, withItemContext wrap. Pulls
                             tool_calls back via getToolCallsForItem(id).
```

**Why hybrid over a pure agent loop**: the README explicitly warns "performative
tool calls will be penalized" and "over-escalation is itself a production
failure mode." A free-form agent loop tends to drift on both axes. Putting
routing and safety in code (LLM extracts signals, deterministic playbooks act
on them) gives auditable, testable, predictable behavior while still
letting Claude do what it's best at — reading messy free-text in two languages.

**Why one LLM call per item, not a multi-step plan**: the per-item decision is
small and the playbook can compute the rest of the plan from the extraction
deterministically. A multi-step plan would burn tokens, add latency, and risk
contradicting the safety overlay. Caching the static system block (policies +
provider roster + JSON schema + worked examples) cuts the marginal input cost
to nearly zero after the first call.

## 4. Failure modes and production eval

### How I self-evaluated this build

Before declaring done, I ran a two-pass self-eval against the inbox:

**Pass 1 — validator + behavior.** Before writing the agent I sketched, per
inbox item, *what is this item probing* (item_2 → safeguarding hidden in a
scheduling ask; item_3 → OON gating; item_4 → existing-patient match;
item_7 → Spanish + bilingual provider; item_8 → P1 same-day). After the first
end-to-end run I `jq`'d the output against that list, then `grep`'d every
`draft_reply` for forbidden phrases (clinical advice, implied-sent,
investigative phrasing). Caught a bad LLM-prefill pattern in `src/llm.ts`
and a missed prompt-cache threshold; fixed both before moving on.

**Pass 2 — rubric audit.** I wrote out the README's 5 weighted rubric rows
as a concrete checklist (Safety 8 rows, Tool orchestration 7, Output
correctness 7, Engineering 7, README 5) and scored every row against the
output. Found three real gaps and fixed them in the polish-pass commit:
(a) `lookup_policy(service_lines)` was being called on every new_referral
even when the discipline was unambiguous — gated it on ambiguity, dropping
total `lookup_policy` calls from 9 to 5 across the batch with no loss of
information; (b) the safeguarding draft included a "call 911" line, which
arguably violates the "neutral acknowledgement only" policy — removed it;
(c) scheduling task notes were a hard-coded template, identical across
items — switched to interpolated notes that quote the family's actual words.

This is the same shape of eval I would put in CI: per-item expected-behavior
assertions + a rubric-scored sample set + a fixed grep over draft bodies.

### Failure modes the current code defends against

| Failure | Defense |
|---|---|
| LLM JSON parse error | retry once with reinforcing instruction; if both fail, fall back to regex extractor |
| LLM down / key missing / rate limited | per-call try/catch → regex fallback; agent still emits a valid `ItemOutput` for every item |
| LLM false-positive safeguarding | overlay requires LLM AND regex agreement for P0; LLM-only signal becomes P1 + clinical-lead notify |
| LLM false-negative safeguarding | regex alone forces classification=safeguarding + P1 (read: human review) |
| Draft body smuggles in clinical advice | post-generation lint rejects + substitutes a safe template |
| Draft implies action ("we have sent…") | same lint catches the verbs and substitutes |
| OON payer with LLM-recommended slot | playbook checks `verify_insurance` result before calling `find_slots`/`hold_slot`; OON branches to billing-only path |
| Item completely unparseable | `buildErrorOutput` produces a thin valid record so the rest of the batch + the validator survive |
| Race conditions across concurrent items | every item runs inside `withItemContext(item.id, …)`, so the trace is correctly partitioned |

### Failure modes I'd add eval coverage for in production

1. **Safety golden set.** Hand-labelled ~200 items with known P0/P1/P2/P3 and
   correct classification. Track precision/recall on the safeguarding label
   weekly. Hard floor: 100% recall on P0 (never miss one); softer ceiling on
   precision (over-escalation hurts but isn't catastrophic if rare). Alert on
   any drop.
2. **Drift on insurance verdicts.** Pair the LLM's `signals.oon_hint` with the
   tool's `verify_insurance` result; when they disagree, log to a dataset. If
   disagreement rate climbs after a policy doc update, something is stale.
3. **Spanish quality.** Sample 5% of `draft_language="es"` outputs weekly and
   route to a bilingual SLP for thumbs up/down. Below 90% thumbs-up = retrain
   the few-shot examples or fall back to a translated template.
4. **Tool-call sanity.** A per-classification "expected tool set" assertion in
   CI (e.g., safeguarding must always include `escalate` + `create_task` for
   `clinical_lead`; OON new_referral must NOT include `hold_slot`). Catches
   silent regressions when the LLM or a playbook drifts.
5. **Latency p95 + token p95 per item.** Alert when either crosses 2x baseline
   — usually means the model is rambling or a prompt change leaked context.
6. **Human-in-the-loop accept rate.** When staff review a `draft_reply`, log
   whether they send-as-is, edit, or rewrite. A rewrite rate over 30% means
   the draft template needs tuning.

## 5. What I chose not to build, and why

- **No tool-use agent loop.** Tempting for the "AI engineer" aesthetic, but the
  README penalizes performative tool calls and over-escalation — both
  failure modes a loop is prone to. Hybrid gave better rubric coverage in
  the time budget.
- **No retrieval over `policies.md`.** It's only ~1.5KB; fits in the cached
  system prompt verbatim. Vector retrieval would be over-engineering at this
  scale.
- **No multi-model orchestration (Opus for reasoning + Haiku for drafting).**
  Single Opus call per item is already cheap with caching and avoids the
  consistency tax of stitching two models' outputs together.
- **No DOB normalization / phone normalization beyond what's in the extractor.**
  Production would want a real phone parser and DOB validator.
- **No idempotency.** Re-running `npm run triage` re-creates tasks, holds, and
  drafts. Fine for a triage prototype; in production the playbooks would key
  on `item_id` and skip duplicates.
- **No richer rationale tracing.** `decision_rationale` is concatenated text,
  not a structured object. Reviewers asked for output correctness over fancy
  observability for this scope.
- **No appointment-conflict detection.** `hold_slot` is called blindly when a
  slot exists; a real system would check the patient's calendar first.

## 6. What I would do with another 4 hours

1. **LLM-proposed tool ordering inside each playbook.** Today each playbook
   runs a fixed tool sequence. With more time I'd let Claude (via `tool_use`)
   propose the order of tool calls inside each playbook *given the
   extraction*, while the deterministic safety overlay still gates the final
   output. The playbook becomes a constraint set ("must call create_task,
   must not call hold_slot when OON") instead of a fixed script. This adds
   the agent-loop demonstration on top of the existing safety guarantees,
   rather than replacing them.
2. **More precise safeguarding patterns.** Build a labeled corpus of 50
   positive + 50 negative examples and tune the regex + LLM prompt to
   maximize recall while keeping false-positive rate under 5%. Run as a
   CI test.
3. **Span-level extraction grounding.** Have the LLM return a `source_span`
   for each field (start/end indices into `body`) so reviewers can see which
   sentence justified each extracted field. Massively boosts auditability.
4. **Real internationalization for drafts.** Today only en/es is supported by
   a single Spanish template plus prompt-driven Spanish drafting. Add a small
   templating layer keyed on `Intl.Locale` so adding a new language is a
   data change, not a code change.
5. **Per-item batch eval harness.** A `npm run eval` script that runs the
   agent against `data/inbox.json` + hidden variants, scores against
   golden labels, and outputs a per-rubric-row report card. Make this the
   pre-PR gate.
6. **Latency budget enforcement.** Wrap the LLM call in a 5s deadline; on
   timeout, fall back to regex extraction with a logged warning. Keeps p99
   bounded under flaky network.

---

## Notes on the assignment constraints

- Tools in `src/tools.ts` are unmodified and called only through `withItemContext`.
- `tools_called[]` is pulled via `getToolCallsForItem(item.id)` unchanged.
- `buildBatchOutput` is called from the starter `src/index.ts`; not touched.
- `requires_human_review` is `true` for every item.
- No `schedule_appointment` or `send_message` calls. Only `draft_message` and `hold_slot` for reviewable artifacts.
- `.env` is in `.gitignore`; the API key is never committed.
- All data is synthetic. No real PHI added.
