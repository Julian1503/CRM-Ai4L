/**
 * Database types for segment tag criteria (20261010000000_segment_tag_criteria.sql).
 *
 * `segment_contacts()` gained one column. Wire it into `SegmentContactRow` in
 * src/lib/db/types.ts as `SegmentContactRow = <existing Pick> & SegmentContactTagColumns`.
 */

export type SegmentContactTagColumns = {
  /** The contact's CRM tag ids, sorted; empty when it has none. */
  tag_ids: string[]
}
