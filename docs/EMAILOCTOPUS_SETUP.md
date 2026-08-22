# EmailOctopus setup

Everything here is done **in the EmailOctopus dashboard**, not in this app. It has to be,
and that constraint shapes the whole campaign feature — so it is worth stating plainly
before the steps.

## Why the email is not authored in the CRM

The EmailOctopus API cannot create or send a campaign. Verified against v1 and v2 on
2026-08-08 and re-confirmed 2026-08-20:

- `/campaigns` is **read-only**. `GET /campaigns`, `GET /campaigns/{id}`, `/reports*`.
  There is no POST, PUT or DELETE anywhere under it.
- `GET /automations` returns 404 — automations cannot even be listed through the API.
- The only programmatic send trigger is `POST /automations/{id}/queue`, which starts an
  automation for **one contact**.

So the message itself lives in an EmailOctopus template, and the only route content takes
into it is **contact custom fields merged into that template**. That is why the CRM's
Campaigns screen edits seven short named values instead of an email body, and why sending
is one API call per recipient rather than one broadcast.

If create-and-send through an API becomes a hard requirement, that is a provider change
(Mailchimp, Brevo and Resend Broadcasts all support it), not a code change to this
screen. `src/lib/marketing/providers/types.ts` is the boundary that keeps the swap
contained.

---

## 1. Custom fields on the list

The list needs one field per merge tag the template references. **A missing field fails
silently** — EmailOctopus merges the field's fallback (null), the email sends with a hole
in it, and nothing in the send ledger, the provider reports, or the CRM shows a problem.

| Tag | Label | Limit | What it holds |
|---|---|---|---|
| `Headline` | Campaign headline | 80 | The main line |
| `Preheader` | Inbox preview text | 120 | Preview beside the subject |
| `Intro` | Opening paragraph | 320 | Two or three sentences |
| `Benefit1` | Benefit 1 | 110 | A concrete outcome |
| `Benefit2` | Benefit 2 | 110 | A second, distinct one |
| `Benefit3` | Benefit 3 | 110 | A third |
| `CtaLabel` | Call-to-action button label | 28 | The button text |
| `BookingUrl` | Booking link | — | **Set per recipient at send time. Never type a value here.** |

**Status: created on the "New Start" list on 2026-08-20.** To check or repair them from
the app, `GET /api/integrations/emailoctopus/fields` reports what is missing and `POST`
to the same path creates it. Both are session-checked.

Two API details worth keeping, found by testing against the live account:

- Creating a field with `"fallback": ""` is rejected `422 — This value should not be
  blank`. **Omit the key entirely**; it stores null. Null is what we want: a fallback
  would paper over a personalisation failure with plausible-looking text.
- Field creation is `POST /lists/{listId}/fields` with `{tag, label, type: "text"}`.
  Deletion is `DELETE /lists/{listId}/fields/{tag}` → 204.

The character limits are enforced by the CRM before anything reaches EmailOctopus, both
for generated copy and for hand-typed edits. They exist because merge values land in a
fixed layout — copy that overruns breaks it rather than wrapping.

---

## 2. The automation

1. Create an automation on the list.
2. Set its trigger type to **"Started via API"**. No other trigger can be started by this
   app.
3. Author the email template, referencing the tags above as `{{Headline}}`,
   `{{Preheader}}`, `{{Intro}}`, `{{Benefit1}}`, `{{Benefit2}}`, `{{Benefit3}}`, and the
   button label as `{{CtaLabel}}`.
4. Point the call-to-action button's href at **`{{BookingUrl}}`**. This is the single most
   important step — it is what connects a campaign to the consultation funnel. Without it
   the email sends, looks correct, and goes nowhere.
5. Copy the automation's id and paste it into the campaign's **EmailOctopus automation
   ID** field in the CRM. A campaign cannot be approved without one; the check is in
   `checkApprovable`, and the database refuses the transition independently.

### "Allow contacts to repeat"

Off by default, which means a contact can trigger an automation **once, ever**. Turn it on
if the same person should be able to receive more than one campaign.

Turning it on moves deduplication entirely onto us. That is already handled — the
`campaign_sends` table has a unique index on `(campaign_id, contact_id)` and only
`pending` rows are processed, so a retried or resumed send cannot double-send. But it is
worth knowing that the safety net is ours, not theirs.

---

## 3. Rate limit and send duration

The token bucket is **100 tokens refilling at 10/second**. Sending is one call per
recipient, so audience size translates directly into wall-clock time:

| Recipients | Approximate send time |
|---|---|
| 500 | ~50 seconds |
| 2,000 | ~3.5 minutes |
| 5,082 (the current list) | ~8.5 minutes |
| 10,000 (the segment cap) | ~17 minutes |

The Campaigns screen shows this estimate **before** approval, because it is a real cost of
the decision. The send endpoint processes one chunk per call and reports whether more
remain, so a long send survives a function timeout by resuming rather than restarting.

---

## 4. What still cannot be verified

**Per-send reporting.** Every EmailOctopus reporting endpoint is keyed to a *campaign*
id. There are no automation reporting endpoints. Opens and clicks for automation-driven
mail most likely never come back through the API at all — recorded in the adapter as
`perSendReporting: 'unknown'` rather than guessed. If open/click tracking in the CRM is
required, confirm this with EmailOctopus support before promising it; today the CRM knows
only whether the send was *queued*, which it records per recipient.

**Bookings are the real metric.** Because open tracking is uncertain and click tracking is
not available, the honest measure of a campaign is the booking rows it produced — those
come back through Stripe and Calendly, which we control.

---

## 5. Compliance

Australian **Spam Act 2003** applies to every campaign sent from here.

- Segments force `subscribed_to_newsletter = true` and exclude archived contacts. This is
  not a UI default — it is applied in `segmentDefinitionToFilters` regardless of what the
  stored segment definition says, so a hand-edited row cannot express a send to people who
  never opted in.
- Generated copy is instructed not to claim the reader requested the message, and not to
  reference a relationship that has not been established.
- Sender identification and a working unsubscribe link are **the template's
  responsibility** — they live in EmailOctopus, so confirm both are present before the
  first real send.

Get written confirmation from the client that the existing 5,082-contact list has consent
to receive marketing before any broad send. That is a legal exposure for them, not just a
deliverability risk.
