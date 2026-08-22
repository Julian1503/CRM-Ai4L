import Anthropic from '@anthropic-ai/sdk'

import {
  buildCopyToolSchema,
  validateCampaignCopy,
  type CampaignCopy,
} from './mergeFields'
import {
  buildRetryPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  type CampaignBrief,
} from './prompt'

/**
 * Campaign copy generation.
 *
 * Structured output through a strict tool rather than prose parsing: the schema is
 * derived from the merge-field contract, so the model is constrained at the tool-call
 * layer and a shape mismatch becomes a retry instead of a regex.
 *
 * `strict: true` is not treated as a guarantee. `validateCampaignCopy` runs on whatever
 * comes back, and its complaints are fed to the model verbatim on the retry — the
 * failure that actually occurs in practice is a value two characters over its cap, and
 * naming it is what gets it fixed.
 *
 * Nothing here writes to the database. A generated draft is a proposal; the caller
 * stores it against a `draft` campaign, and a human still has to approve before it can
 * send. That gate is enforced by a trigger in the database, not by this module.
 */

export const COPY_TOOL_NAME = 'write_campaign_copy'

/** Opus for copy: the constraint-juggling (voice, length caps, compliance) is the hard part. */
export const COPY_MODEL = 'claude-opus-5'

/** One retry. A second failure is a prompt problem, not a dice roll worth paying for. */
export const MAX_ATTEMPTS = 2

export type GenerationUsage = {
  inputTokens: number
  outputTokens: number
}

export type GenerationResult =
  | { ok: true; copy: CampaignCopy; attempts: number; usage: GenerationUsage }
  | { ok: false; error: string; attempts: number; validationErrors?: string[] }

/**
 * Configuration, read at call time.
 *
 * Mirrors `getStripeConfig` — a missing key must surface as a handled error on the one
 * route that needs it, not as a module-load failure that takes the whole app down.
 */
export function getAnthropicApiKey(): string | null {
  return process.env.ANTHROPIC_API_KEY?.trim() || null
}

export function createAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey })
}

/** The narrow slice of the SDK this module uses, so tests can substitute it. */
export type MessagesApi = {
  create(
    params: Anthropic.MessageCreateParamsNonStreaming
  ): Promise<Anthropic.Message>
}

function copyTool(): Anthropic.Tool {
  return {
    name: COPY_TOOL_NAME,
    description:
      'Submit the campaign copy. Every slot is required and each has a hard ' +
      'character limit. Plain text only.',
    strict: true,
    input_schema: buildCopyToolSchema() as unknown as Anthropic.Tool.InputSchema,
  }
}

/** Pulls the tool input out of a response, or explains why there is none. */
function extractToolInput(
  message: Anthropic.Message
): { ok: true; input: unknown } | { ok: false; reason: string } {
  // A safety decline arrives as a 200 with no usable content, so it has to be checked
  // before reading blocks rather than after.
  if (message.stop_reason === 'refusal') {
    return { ok: false, reason: 'The model declined to write this campaign.' }
  }

  for (const block of message.content) {
    if (block.type === 'tool_use' && block.name === COPY_TOOL_NAME) {
      return { ok: true, input: block.input }
    }
  }

  if (message.stop_reason === 'max_tokens') {
    return { ok: false, reason: 'The response was cut off before the copy was submitted.' }
  }

  return { ok: false, reason: `The model did not call ${COPY_TOOL_NAME}.` }
}

/**
 * Generates one campaign's copy.
 *
 * Takes the messages API rather than a client so a test can supply a plain object —
 * the SDK is never constructed in unit tests, per the testing note in PLAN.md.
 */
export async function generateCampaignCopy(
  messages: MessagesApi,
  brief: CampaignBrief
): Promise<GenerationResult> {
  const system = buildSystemPrompt(brief.brandVoice ?? undefined)
  const conversation: Anthropic.MessageParam[] = [
    { role: 'user', content: buildUserPrompt(brief) },
  ]

  let lastValidationErrors: string[] | undefined
  let lastReason = 'Generation produced no usable copy.'

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let message: Anthropic.Message

    try {
      message = await messages.create({
        model: COPY_MODEL,
        max_tokens: 16000,
        system,
        tools: [copyTool()],
        messages: conversation,
      })
    } catch (error) {
      return { ok: false, error: describeApiError(error), attempts: attempt }
    }

    const extracted = extractToolInput(message)

    if (!extracted.ok) {
      // A refusal will not be argued out of, and a truncated response will truncate
      // again at the same limit. Neither is worth a second call.
      return { ok: false, error: extracted.reason, attempts: attempt }
    }

    const validation = validateCampaignCopy(extracted.input)

    if (validation.ok) {
      return {
        ok: true,
        copy: validation.value,
        attempts: attempt,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
        },
      }
    }

    lastValidationErrors = validation.errors
    lastReason = `Generated copy failed validation: ${validation.errors.join(' ')}`

    // Echo the assistant turn back before complaining about it, so the retry sees what
    // it wrote rather than being asked to fix copy it cannot see.
    conversation.push(
      { role: 'assistant', content: message.content },
      { role: 'user', content: buildRetryPrompt(validation.errors) }
    )
  }

  return {
    ok: false,
    error: lastReason,
    attempts: MAX_ATTEMPTS,
    validationErrors: lastValidationErrors,
  }
}

/**
 * Turns an SDK error into something an operator can act on.
 *
 * Most specific first. The distinction that matters on this route is between "your key
 * is wrong" (fix the deployment) and "slow down" (try again), because they look
 * identical in a generic error banner.
 */
export function describeApiError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return 'The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.'
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return 'The Anthropic API key does not have access to this model.'
  }
  if (error instanceof Anthropic.RateLimitError) {
    return 'Anthropic rate limit reached. Try again shortly.'
  }
  if (error instanceof Anthropic.BadRequestError) {
    return `Anthropic rejected the request: ${error.message}`
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return 'Could not reach the Anthropic API.'
  }
  if (error instanceof Anthropic.APIError) {
    return `Anthropic API error${error.status ? ` (${error.status})` : ''}: ${error.message}`
  }
  return error instanceof Error ? error.message : 'Copy generation failed.'
}
