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
their reasons. The numbers come from `preview_import_contacts()`, which applies the
import's own rules without writing.

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
