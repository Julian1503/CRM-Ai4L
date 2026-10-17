# Content Studio — AI suggestions plan

Status: approved 2026-10-17. Suggestions are written in **English**; each member may ask
for **50 per minute**. Every suggestion comes from the model (no hard-coded lists).

## What is suggested

| Kind | Where | Context sent to the model | Returns |
| --- | --- | --- | --- |
| `rewrite_instructions` | "Regenerate this variant" dialog (`VariantCard.tsx`) | Current revision text, channel, its violations and rejection reason | 4 short instructions (≤ 120 chars) |
| `image_prompts` | Image generation form (`AssetLibrary.tsx`) | Item title and brief, up to 3 current variant texts, `brand.imageDirection`, prompts already used on the item | 4 `{ label, prompt }` |
| `brief_completion` | "Complete with AI" in `BriefForm.tsx` once a topic is written | Topic and whatever the member already typed, brand tone/audience, approved facts | One `{ title, audience, objective, notes, factIds, channels }` |
| `content_ideas` | "Ideas" on the new-brief screen | Recent item titles (to avoid repeats), unused newsletter topics, brand facts and tone | 5 `{ title, topic, angle, channels }` |

Rules shared by every kind:

* A suggestion only fills a field. The member can edit it; nothing is submitted for them.
* Asked on demand (dialog opened, button pressed), never while typing.
* `factIds` must be ids of the brand's approved facts — anything else is dropped by the
  engine, so a completed brief can never carry an invented fact.
* No personal data reaches the model: no contacts, emails or bookings — content and
  brand only. `referenceUrl` is not fetched for suggestions.
* Suggestions containing a URL are dropped.

## Architecture

```
Browser ─► POST /api/content-studio/suggestions        (Vercel: session, flag, body validation,
              │                                          context built from the DB with the
              │                                          member's client, so RLS applies)
              │  HMAC with CONTENT_ENGINE_SECRET
              ▼
       ContentEngineApi  POST /v1/suggest/{kind}         (Railway: prompt, LLM, output sanitising)
```

Suggestions do not use the `content_jobs` queue: they have no side effect and the member
waits for them on screen. They use the synchronous CRM → engine channel OAuth already uses.

The browser sends only `{ kind, itemId?, variantId?, topic?, draft?, fresh? }`.

### Engine (`services/content-engine`)

* `app/suggestions/` — one pydantic context model, prompt and deterministic mock per kind,
  plus the sanitiser (counts, lengths, URLs, fact ids, channels).
* `POST /v1/suggest/{kind}` in `app/main.py`, authenticated like the OAuth routes.
* `llm.py` — `complete_structured(prompt, schema, offline=...)` next to `complete_json`, so
  any schema can be asked for without a `DraftContext`.
* `SUGGEST_DEADLINE_SECONDS` (default 25) bounds the whole call, retries included.

### CRM (Next.js + Supabase)

* `src/lib/content-studio/engineHttp.ts` — the signed `post` and `EngineError`, extracted
  from `src/lib/social/engineClient.ts` so both clients share them.
* `src/lib/content-studio/suggestionContext.ts` — one context builder per kind.
* `src/lib/content-studio/suggestions.ts` — cache lookup, rate-limit slot, engine call, result.
* `POST /api/content-studio/suggestions`.
* Migration `content_suggestion_requests`:
  * **rate limit** — `claim_content_suggestion()` refuses (CRM10 → 429) a member's 51st
    request within a minute; a serverless in-memory counter would not hold on Vercel;
  * **cache** — a result is reused for 24 h for the same kind and context hash; `fresh`
    skips the cache and sends the previous result as "avoid these";
  * **usage** — model, tokens and latency per request, to measure the real cost.

## Phases

1. **F0 — backend**: engine endpoint for the four kinds, LLM refactor, shared client,
   route, migration, rate limit and cache. Tests on both sides with mocks.
2. **F1 — rewrite instructions and image prompts**: shared `<SuggestionChips>` component
   (loading, quiet error with retry, keyboard), wired into the two existing forms.
3. **F2 — brief completion**: per-field "Use" so typed values are never overwritten.
4. **F3 — content ideas**: entry point on the new-brief screen; an idea prefills the brief.
5. **Each release**: migration to production (dry-run and backup first), redeploy the
   `ContentEngineApi` Railway service (the worker does not change), push `staging`. No new
   environment variables are required.
