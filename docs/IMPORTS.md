# Contact edits and imports

Audit findings H8, H9 and P3. Migrations `20261004000000_contact_save.sql` and
`20261004010000_import_field_presence.sql`.

## Saving a contact (H8)

The drawer saves through `POST /api/contacts` (create) or `PUT /api/contacts/[id]`
(update), which call one database function, `save_contact()`. The contact, its
organisation and its services are written in a single transaction, or not at all.

- Every reference is validated first: an unknown service or job type is refused and
  **nothing changes** — in particular, existing service links are not removed.
- Organisations are matched the way their unique index compares them
  (`lower(btrim(name))`), so "Acme " and "ACME" are one organisation.
- Updates carry `expectedRevision`. If someone else saved the contact in the meantime the
  save is refused with a clear message, and the drawer keeps the draft open.
- Consent changes made here are attributed to `crm_operator` in the consent ledger and
  queued for EmailOctopus in the same transaction.

**Data review (release step).** The old four-request save could lose a contact's services
when a request failed between the delete and the insert. The CRM kept no history of
service links, so lost links cannot be reconstructed automatically. If staff know of
customers whose services disappeared, re-enter them by hand; do not infer services.

## Required columns

A file needs **one** of these column sets (headers can be named anything; they are
matched to CRM fields on the mapping screen):

- `Email + First Name + Last Name`, or
- `Email + Full Name` — each Full Name cell must hold a first and a last name separated by
  a space (`Ada Lovelace`); a single word rejects that row.

Every other column is optional. The rule is written once, as `IMPORT_REQUIREMENT_OPTIONS`
in `src/lib/contacts/importFields.ts`, and read by both the "Which columns do I need?"
help (`src/components/import/ImportRequirements.tsx`) and the mapping check
(`describeMissingRequirements()` in `columnMapping.ts`, shown by `ImportMappingStatus`),
so the help cannot promise what the check refuses. Cell contents (a valid address, a Full
Name that splits) are still checked per row by `mapAndValidateRows()` in `excelParser.ts`.

## Tags

- Column `Tags` (also recognised as `Tag`, `Labels`, `Etiquetas`…). Separator `;`, e.g.
  `VIP; Workshop 2026`. Blank entries (`VIP;;`) are ignored; repeats are removed without
  regard to case, keeping the first spelling.
- Limits: 80 characters per tag and 50 tags per contact (`TAG_NAME_MAX_LENGTH`,
  `MAX_TAGS_PER_CONTACT`). A row over a limit is **rejected with the reason**, never cut
  short — truncating could merge it into a different existing tag.
- **Common tags**: the operator can add tags to every accepted row. They are merged into
  each row's own tags by `mapAndValidateRows(rows, mapping, { commonTags })` — the merge
  counts toward the 50-tag limit — so the preview and the import send the same list.
  Changing the mapping or the common tags changes the validated rows, which drops the
  shown preview and requests a new one.
- An import only **adds** tags. A blank cell or an unmapped column keeps the contact's
  existing tags; removing tags is done in the drawer or with the bulk action.

**Payload contract (`ImportContactPayloadRow.tag_names`).** Present only when the row has
at least one tag; already normalised (trimmed, inner spaces collapsed), deduplicated
case-insensitively, each ≤ 80 characters and ≤ 50 names. The database functions must:

- match names to the catalog by `lower(btrim(name))`, creating missing tags only in
  `import_contacts()`, never in `preview_import_contacts()`;
- add, never remove, links; treat absent or `[]` as "keep the contact's tags";
- bump `contacts.revision` only when a link is actually added (a re-import is stable);
- re-validate the limits server-side, including the **resulting** tag count of an existing
  contact. As implemented (`20261006010000_import_contact_tags.sql`), a violation refuses
  the whole preview/import with `CRM07` (hint `tag_limit`) naming the contact — tags are
  never dropped. The client can only check the file's own tags, so this surfaces as the
  preview error;
- report `tags_assigned` (contacts gaining at least one tag), `tags_only_changed` (matched
  contacts whose only change is new tags, also counted in `changed`) and `tags_created`
  (catalog names that do not exist yet) in the preview.

## Industry is not a Job Type

`Industry` describes the **organisation's** sector (`organisations.industry`), not the
contact's Job Type. Headers containing the word `industry` or `sector` are therefore no
longer mapped to Job Type automatically: `analyseHeaders()` reports them as ambiguous and
the mapping screen asks the operator to choose (map it to Job Type if the column really
holds job types, or leave it unmapped). Older files are never reinterpreted silently.
`trade`, `category` and `job type` still map to Job Type.

**Future work (not in this phase):** importing the organisation sector from a file needs an
unambiguous `Organisation Industry` field, parser/payload/RPC and preview support,
detection of conflicting sectors for one organisation within a file, and a preview token
that also covers organisation data. Until then, sector is edited in Settings.

## Importing (H9)

What a spreadsheet can change on an **existing** contact:

| Field | Value in the file | Effect |
| --- | --- | --- |
| Name, phone, address, position, organisation, job type… | a value | replaces |
|  | blank, or column not mapped | **kept** — an import never erases details |
| Customer | yes / true / 1 / y | becomes a customer |
|  | no / false / 0 / n | a customer becomes a prospect; a lead stays a lead |
|  | blank, or column not mapped | **status kept** |
|  | anything else | the row is rejected with a reason |
| Newsletter / Courses consent | no | consent withdrawn |
|  | yes | never re-grants consent someone withdrew |
|  | blank, or not mapped | kept |
| Tags | names separated by `;` | **added** to the contact's tags |
|  | blank, or not mapped | kept (common tags are still added) |

For a **new** contact: customer defaults to prospect, and consent defaults to granted
unless the file withholds it (or the address's latest removed record had withdrawn it).

Other rules:
- An address repeated in one file: the **first** row is used; the rest are counted as
  "repeated in the file".
- An address that belongs to an archived contact is held back, never imported.

## Change preview (P3)

Before anything is written, the importer shows what the import will do — new, updated,
unchanged, rejected, repeated and held-back counts; how many contacts become or stop being
customers; how many lose each consent — with example rows and a CSV of rejected rows and
their reasons; how many contacts receive new tags, how many change only by receiving tags,
and which tag names will be created. The numbers come from `preview_import_contacts()`,
which applies the import's own rules without writing (it does not create tags either).

A shown preview belongs to the rows it was computed for. `ImportChangePreview` drops it —
and the Import button with it — as soon as its `onPreview` prop changes (the page recreates
it when the mapping or the common tags change), requests a new one, and ignores a late
answer to an older request.

The preview carries a token over every existing contact it matched. The import is sent
with that token and is refused if any of those contacts changed in the meantime; the
operator sees a fresh preview instead of an obsolete one being applied. The upload and
column mapping are kept after any failure.

**Recorded decision (plan 14.5):** blank cells never clear a field on import — clearing is
done in the contact drawer. Unrecognised yes/no values reject the row rather than guessing.

## Verification

- `npm run db:verify -- contacts2`
- `npm run test:integration` — atomic rollback on an invalid service, edit conflicts,
  organisation matching, customer preservation, preview/import agreement, stale preview.
