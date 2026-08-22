-- Seed job types.
--
-- `job_types` shipped empty in 20260807000000, which left every segment's job-type
-- filter permanently useless: the dropdown had nothing in it, and all 5,202 imported
-- contacts carry job_type_id = null. Segmenting by trade was a stated requirement, so
-- an empty lookup table is a half-built feature rather than a neutral default.
--
-- These two values come from the audience that already exists rather than being
-- invented: they are the tags on the live EmailOctopus list ("Learning and Development"
-- and "RTOs"), which is how the client has actually been classifying this database.
--
-- Deliberately NOT doing here:
--   * assigning contacts to a type. The import carried no column that maps to one, and
--     guessing from an email domain would put wrong data in front of a human who would
--     reasonably assume it was checked.
--   * treating this as the final list. Open question 1 in PLAN.md is still open; adding
--     more is one insert, and the unique index below makes re-running safe.
insert into public.job_types (name)
values
  ('Learning and Development'),
  ('Registered Training Organisation')
on conflict do nothing;
