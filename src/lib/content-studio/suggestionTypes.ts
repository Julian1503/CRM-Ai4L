import type { ContentChannel } from './types'

/**
 * AI suggestions (docs/CONTENT_STUDIO_SUGGESTIONS_PLAN.md): what the browser asks for and
 * what it gets back. The browser names only ids and its own typing; the server builds the
 * context from the database, so nothing it sends to the engine comes unchecked from here.
 */

export const SUGGESTION_KINDS = ['rewrite_instructions', 'image_prompts', 'brief_completion', 'content_ideas'] as const
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number]

/** What the member already typed in the brief; the completion keeps its intent. */
export interface BriefDraftFields {
  title?: string
  audience?: string
  objective?: string
  notes?: string
}

/** `fresh` skips the cache and asks for suggestions different from the cached ones. */
export type SuggestionRequest =
  | { kind: 'rewrite_instructions'; variantId: string; fresh?: boolean }
  | { kind: 'image_prompts'; itemId: string; fresh?: boolean }
  | { kind: 'brief_completion'; topic: string; draft: BriefDraftFields; fresh?: boolean }
  | { kind: 'content_ideas'; fresh?: boolean }

export interface RewriteSuggestion {
  text: string
}

export interface ImagePromptSuggestion {
  label: string
  prompt: string
}

/** Fact ids always name approved facts of the brand; the engine drops any other. */
export interface BriefCompletion extends BriefDraftFields {
  factIds: string[]
  channels: ContentChannel[]
}

export interface ContentIdea {
  title: string
  topic: string
  angle: string
  channels: ContentChannel[]
}

type Answer<K extends SuggestionKind, T> = { kind: K; cached: boolean } & T

export type SuggestionResponse =
  | Answer<'rewrite_instructions', { suggestions: RewriteSuggestion[] }>
  | Answer<'image_prompts', { suggestions: ImagePromptSuggestion[] }>
  | Answer<'brief_completion', { completion: BriefCompletion }>
  | Answer<'content_ideas', { suggestions: ContentIdea[] }>
