/* Assign contacts a job type from their EmailOctopus tags.

Usage:
  npm run db:sync-job-types -- --dry-run   # report only, changes nothing
  npm run db:sync-job-types                # apply

Reads (from .env.local via `node --env-file`):
  NEXT_PUBLIC_SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY   (service_role; bypasses RLS, keep secret)
  EMAILOCTOPUS_API_KEY
  EMAILOCTOPUS_LIST_ID

Why this exists
---------------
`job_types` shipped empty and every imported contact had `job_type_id = null`, so the
job-type filter -- and therefore every segment built on it -- was inert. PLAN.md recorded
this as blocked because "the import carried no column that maps to a job type", and
guessing one from an email domain would put unchecked data in front of someone who would
reasonably assume it had been checked.

The import file was the wrong place to look. The client has been classifying this
database all along, in EmailOctopus, as per-contact tags: "RTOs" and
"Learning and Development". That is their own classification, not an inference, so
importing it is a data transfer rather than a guess.

Kept as a script rather than run once and forgotten, because the problem recurs: every
contact added by a later spreadsheet import or by the newsletter form arrives with no
job type, and re-running this is how they get one.

Deliberately NOT done here
--------------------------
  * Inventing job types. Only tags that already map to an existing row in `job_types`
    are applied; an unrecognised tag is reported and skipped, because creating one
    silently would let a typo in EmailOctopus become a segment.
  * Resolving contacts carrying more than one tag. Which type wins is a judgement about
    the client's business, so those are listed for a human instead.
  * Overwriting a job type that is already set. This only fills blanks and corrects
    rows that disagree with the tag; it never clears one.
*/

const TAG_TO_JOB_TYPE = {
  RTOs: 'Registered Training Organisation',
  'Learning and Development': 'Learning and Development',
};

const EO_API = 'https://api.emailoctopus.com';
const PAGE = 100;
/** PostgREST caps a response at 1000 rows; read the contact book a window at a time. */
const DB_PAGE = 1000;
/** Batch size for the update. Keeps the `id=in.(...)` filter well inside URL limits. */
const UPDATE_BATCH = 200;

function requireEnv(name) {
  const value = (process.env[name] || '').trim();
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

/**
 * Every contact on the list, with their tags.
 *
 * Statuses are fetched explicitly. The default listing returns subscribed contacts
 * only, which silently omitted 120 unsubscribed rows on the live list -- they are still
 * contacts in the CRM and still need classifying.
 */
async function fetchTagsByEmail(apiKey, listId) {
  const byEmail = new Map();

  for (const status of ['subscribed', 'unsubscribed', 'pending']) {
    let url = `${EO_API}/lists/${encodeURIComponent(listId)}/contacts?limit=${PAGE}&status=${status}`;

    while (url) {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });

      if (!response.ok) {
        throw new Error(`EmailOctopus ${status} listing failed: ${response.status}`);
      }

      const body = await response.json();

      for (const contact of body.data || []) {
        byEmail.set(String(contact.email_address || '').toLowerCase(), contact.tags || []);
      }

      url = body.paging?.next?.url || null;
    }
  }

  return byEmail;
}

async function fetchAllContacts(url, headers) {
  const rows = [];

  for (let from = 0; ; from += DB_PAGE) {
    const response = await fetch(
      `${url}/rest/v1/contacts?select=id,email,job_type_id&deleted_at=is.null&order=id`,
      { headers: { ...headers, Range: `${from}-${from + DB_PAGE - 1}` } },
    );

    if (!response.ok) throw new Error(`Reading contacts failed: ${response.status}`);

    const page = await response.json();
    rows.push(...page);

    if (page.length < DB_PAGE) return rows;
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const url = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  const serviceRole = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const apiKey = requireEnv('EMAILOCTOPUS_API_KEY');
  const listId = requireEnv('EMAILOCTOPUS_LIST_ID');

  const headers = {
    'Content-Type': 'application/json',
    apikey: serviceRole,
    Authorization: `Bearer ${serviceRole}`,
  };

  const jobTypesResponse = await fetch(`${url}/rest/v1/job_types?select=id,name`, { headers });
  if (!jobTypesResponse.ok) throw new Error(`Reading job_types failed: ${jobTypesResponse.status}`);

  const jobTypes = await jobTypesResponse.json();
  const idByName = new Map(jobTypes.map((row) => [row.name, row.id]));
  const nameById = new Map(jobTypes.map((row) => [row.id, row.name]));

  const tagsByEmail = await fetchTagsByEmail(apiKey, listId);
  const contacts = await fetchAllContacts(url, headers);

  const idsByJobType = new Map();
  const ambiguous = [];
  const unknownTags = new Map();
  const untagged = [];
  const noJobTypeTag = [];
  let alreadyCorrect = 0;

  for (const contact of contacts) {
    const tags = tagsByEmail.get(String(contact.email || '').toLowerCase());

    if (!tags) {
      untagged.push(contact.email);
      continue;
    }

    const mapped = tags.filter((tag) => TAG_TO_JOB_TYPE[tag]);

    for (const tag of tags) {
      if (!TAG_TO_JOB_TYPE[tag]) unknownTags.set(tag, (unknownTags.get(tag) || 0) + 1);
    }

    // More than one is a business judgement, not a data problem: leave it for a human
    // rather than letting tag order decide which segment someone lands in.
    if (mapped.length > 1) {
      ambiguous.push({ email: contact.email, tags });
      continue;
    }

    // On the list but carrying nothing that classifies them -- a newsletter signup, or
    // an account added by hand. Reported rather than skipped in silence, because an
    // unclassified contact is invisible to every segment.
    if (mapped.length === 0) {
      noJobTypeTag.push(contact.email);
      continue;
    }

    const jobTypeId = idByName.get(TAG_TO_JOB_TYPE[mapped[0]]);
    if (!jobTypeId) {
      unknownTags.set(mapped[0], (unknownTags.get(mapped[0]) || 0) + 1);
      continue;
    }

    if (contact.job_type_id === jobTypeId) {
      alreadyCorrect += 1;
      continue;
    }

    if (!idsByJobType.has(jobTypeId)) idsByJobType.set(jobTypeId, []);
    idsByJobType.get(jobTypeId).push(contact.id);
  }

  const toChange = [...idsByJobType.values()].reduce((sum, ids) => sum + ids.length, 0);

  console.log(`Contacts in CRM:        ${contacts.length}`);
  console.log(`Tagged in EmailOctopus: ${tagsByEmail.size}`);
  console.log(`Already correct:        ${alreadyCorrect}`);
  console.log(`To ${dryRun ? 'change (dry run)' : 'change'}:         ${toChange}`);

  for (const [jobTypeId, ids] of idsByJobType) {
    console.log(`  ${nameById.get(jobTypeId)} -> ${ids.length}`);
  }

  if (untagged.length) {
    console.log(`\nNot on the EmailOctopus list (${untagged.length}), left unassigned:`);
    for (const email of untagged.slice(0, 20)) console.log(`  ${email}`);
    if (untagged.length > 20) console.log(`  ... and ${untagged.length - 20} more`);
  }

  if (noJobTypeTag.length) {
    console.log(`\nOn the list but with no job-type tag (${noJobTypeTag.length}), left unassigned:`);
    for (const email of noJobTypeTag.slice(0, 20)) console.log(`  ${email}`);
    if (noJobTypeTag.length > 20) console.log(`  ... and ${noJobTypeTag.length - 20} more`);
  }

  if (ambiguous.length) {
    console.log(`\nMore than one job-type tag (${ambiguous.length}) -- needs a human decision:`);
    for (const row of ambiguous) console.log(`  ${row.email}: ${row.tags.join(', ')}`);
  }

  if (unknownTags.size) {
    console.log('\nTags with no matching job_types row (skipped, nothing was invented):');
    for (const [tag, count] of unknownTags) console.log(`  ${tag} (${count})`);
  }

  if (dryRun || toChange === 0) return;

  let updated = 0;

  for (const [jobTypeId, ids] of idsByJobType) {
    for (let i = 0; i < ids.length; i += UPDATE_BATCH) {
      const batch = ids.slice(i, i + UPDATE_BATCH);
      const response = await fetch(`${url}/rest/v1/contacts?id=in.(${batch.join(',')})`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({ job_type_id: jobTypeId }),
      });

      if (!response.ok) {
        throw new Error(`Update failed after ${updated} rows: ${response.status} ${await response.text()}`);
      }

      updated += batch.length;
    }
  }

  console.log(`\nUpdated ${updated} contacts.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
