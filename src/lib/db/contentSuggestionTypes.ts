/**
 * Database types for AI suggestion requests (20261017000000_content_suggestions.sql).
 * Wired into `Database` in src/lib/db/types.ts.
 */

import type { SuggestionKind } from '@/lib/content-studio/suggestionTypes'

type Json = unknown

export type ContentSuggestionStatus = 'pending' | 'succeeded' | 'failed'

export type ContentSuggestionRequestRow = {
  id: string
  requested_by: string | null
  kind: SuggestionKind
  /** sha256 hex of the context sent to the engine. */
  context_hash: string
  status: ContentSuggestionStatus
  result: Json | null
  model: string | null
  prompt_version: string | null
  usage: Record<string, number>
  latency_ms: number | null
  /** A short snake_case code, never free error text. */
  error_code: string | null
  created_at: string
  finished_at: string | null
}

export type ContentSuggestionTables = {
  content_suggestion_requests: {
    Row: ContentSuggestionRequestRow
    Insert: never
    Update: never
    Relationships: []
  }
}

export type ContentSuggestionFunctions = {
  claim_content_suggestion: {
    Args: { p_kind: SuggestionKind; p_context_hash: string }
    Returns: string
  }
  finish_content_suggestion: {
    Args: {
      p_id: string
      p_status: 'succeeded' | 'failed'
      p_result: Json | null
      p_model: string | null
      p_prompt_version: string | null
      p_usage: Json | null
      p_latency_ms: number | null
      p_error_code: string | null
    }
    Returns: undefined
  }
}
