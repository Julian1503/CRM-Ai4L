import Anthropic from '@anthropic-ai/sdk'

import {
  COPY_MODEL,
  COPY_TOOL_NAME,
  MAX_ATTEMPTS,
  describeApiError,
  generateCampaignCopy,
  getAnthropicApiKey,
  type MessagesApi,
} from './generateCampaign'
import { BOOKING_URL_MERGE_FIELD, CAMPAIGN_COPY_FIELDS } from './mergeFields'
import type { CampaignBrief } from './prompt'

const BRIEF: CampaignBrief = {
  campaignName: 'Spring outreach',
  audience: { segmentName: 'Victorian RTOs', size: 412, state: 'VIC' },
}

/** Copy that passes validation, sized to each field's cap. */
function goodCopy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const copy: Record<string, unknown> = {}
  for (const field of CAMPAIGN_COPY_FIELDS) {
    copy[field.tag] = 'Sound copy'
  }
  return { ...copy, ...overrides }
}

function toolUseMessage(input: unknown): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: COPY_MODEL,
    stop_reason: 'tool_use',
    stop_sequence: null,
    content: [{ type: 'tool_use', id: 'tu_1', name: COPY_TOOL_NAME, input }],
    usage: { input_tokens: 900, output_tokens: 120 },
  } as unknown as Anthropic.Message
}

function textMessage(
  text: string,
  stopReason: string = 'end_turn'
): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: COPY_MODEL,
    stop_reason: stopReason,
    stop_sequence: null,
    content: [{ type: 'text', text, citations: null }],
    usage: { input_tokens: 900, output_tokens: 20 },
  } as unknown as Anthropic.Message
}

/** A messages API that returns the given responses in order. */
function stubApi(responses: Anthropic.Message[]): MessagesApi & {
  calls: Anthropic.MessageCreateParamsNonStreaming[]
} {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = []
  let index = 0

  return {
    calls,
    async create(params) {
      calls.push(params)
      const response = responses[Math.min(index, responses.length - 1)]
      index += 1
      return response
    },
  }
}

describe('generateCampaignCopy — request shape', () => {
  test('asks the configured model with the strict copy tool', async () => {
    const api = stubApi([toolUseMessage(goodCopy())])

    await generateCampaignCopy(api, BRIEF)

    const [request] = api.calls
    expect(request.model).toBe(COPY_MODEL)
    expect(request.tools).toHaveLength(1)

    const tool = request.tools![0] as Anthropic.Tool
    expect(tool.name).toBe(COPY_TOOL_NAME)
    expect(tool.strict).toBe(true)
    expect(tool.input_schema).toMatchObject({ additionalProperties: false })
  })

  test('sends the brief in the user turn and the voice in the system prompt', async () => {
    const api = stubApi([toolUseMessage(goodCopy())])

    await generateCampaignCopy(api, BRIEF)

    const [request] = api.calls
    expect(request.messages[0].content).toContain('Victorian RTOs')
    expect(String(request.system)).toContain('Spam Act 2003')
  })

  test('never sends contact details, even when a segment search holds one', async () => {
    const api = stubApi([toolUseMessage(goodCopy())])

    await generateCampaignCopy(api, {
      campaignName: 'Follow-ups',
      audience: {
        segmentName: 'Saved search',
        size: 2,
        search: 'yvonnec@status.net.au',
      },
      notes: 'Ring 0412 345 678 first.',
    })

    const serialised = JSON.stringify(api.calls[0])
    expect(serialised).not.toContain('yvonnec@status.net.au')
    expect(serialised).not.toContain('0412 345 678')
  })

  test('does not offer the booking link as something the model can write', async () => {
    const api = stubApi([toolUseMessage(goodCopy())])

    await generateCampaignCopy(api, BRIEF)

    const tool = api.calls[0].tools![0] as Anthropic.Tool
    const properties = (tool.input_schema as { properties: Record<string, unknown> })
      .properties

    expect(properties[BOOKING_URL_MERGE_FIELD]).toBeUndefined()
  })
})

describe('generateCampaignCopy — success', () => {
  test('returns validated copy and the token usage', async () => {
    const api = stubApi([toolUseMessage(goodCopy({ Headline: '  Trimmed  ' }))])

    const result = await generateCampaignCopy(api, BRIEF)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.copy.Headline).toBe('Trimmed')
    expect(result.attempts).toBe(1)
    expect(result.usage).toEqual({ inputTokens: 900, outputTokens: 120 })
  })

  test('makes exactly one call when the first response is valid', async () => {
    const api = stubApi([toolUseMessage(goodCopy())])

    await generateCampaignCopy(api, BRIEF)

    expect(api.calls).toHaveLength(1)
  })
})

describe('generateCampaignCopy — retry', () => {
  test('retries once when validation fails, and names the failures', async () => {
    const headline = CAMPAIGN_COPY_FIELDS.find((f) => f.tag === 'Headline')!
    const api = stubApi([
      toolUseMessage(goodCopy({ Headline: 'x'.repeat(headline.maxLength + 5) })),
      toolUseMessage(goodCopy()),
    ])

    const result = await generateCampaignCopy(api, BRIEF)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.attempts).toBe(2)

    const retry = api.calls[1]
    expect(retry.messages).toHaveLength(3)
    expect(String(retry.messages[2].content)).toContain('Headline is')
  })

  test('echoes the rejected attempt back so the retry can see it', async () => {
    const api = stubApi([toolUseMessage(goodCopy({ CtaLabel: '' })), toolUseMessage(goodCopy())])

    await generateCampaignCopy(api, BRIEF)

    expect(api.calls[1].messages[1].role).toBe('assistant')
  })

  test('gives up after the attempt cap and reports why', async () => {
    const api = stubApi([toolUseMessage(goodCopy({ CtaLabel: '   ' }))])

    const result = await generateCampaignCopy(api, BRIEF)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.attempts).toBe(MAX_ATTEMPTS)
    expect(api.calls).toHaveLength(MAX_ATTEMPTS)
    expect(result.validationErrors).toContain('CtaLabel is empty.')
  })

  test('rejects copy that tries to overwrite the booking link', async () => {
    const api = stubApi([
      toolUseMessage(goodCopy({ [BOOKING_URL_MERGE_FIELD]: 'https://evil.example' })),
    ])

    const result = await generateCampaignCopy(api, BRIEF)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.validationErrors?.join(' ')).toContain(BOOKING_URL_MERGE_FIELD)
  })
})

describe('generateCampaignCopy — unusable responses', () => {
  test('does not retry a refusal', async () => {
    const api = stubApi([textMessage('I cannot help with that.', 'refusal')])

    const result = await generateCampaignCopy(api, BRIEF)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('declined')
    expect(api.calls).toHaveLength(1)
  })

  test('reports a truncated response rather than retrying into the same limit', async () => {
    const api = stubApi([textMessage('Here is the cop', 'max_tokens')])

    const result = await generateCampaignCopy(api, BRIEF)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('cut off')
    expect(api.calls).toHaveLength(1)
  })

  test('reports prose when the model answers without calling the tool', async () => {
    const api = stubApi([textMessage('Sure! Here is some copy.')])

    const result = await generateCampaignCopy(api, BRIEF)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain(COPY_TOOL_NAME)
  })

  test('surfaces an API failure instead of throwing', async () => {
    const api: MessagesApi = {
      async create() {
        throw new Error('socket hang up')
      },
    }

    const result = await generateCampaignCopy(api, BRIEF)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('socket hang up')
  })
})

describe('describeApiError', () => {
  test('tells an operator to check the key on an auth failure', () => {
    const error = new Anthropic.AuthenticationError(
      401,
      { type: 'error', error: { type: 'authentication_error', message: 'bad key' } },
      'bad key',
      new Headers()
    )

    expect(describeApiError(error)).toContain('ANTHROPIC_API_KEY')
  })

  test('distinguishes a rate limit, which is worth retrying', () => {
    const error = new Anthropic.RateLimitError(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
      'slow down',
      new Headers()
    )

    expect(describeApiError(error)).toContain('rate limit')
  })

  test('falls back to the message on an unrecognised error', () => {
    expect(describeApiError(new Error('boom'))).toBe('boom')
  })

  test('handles a thrown non-error', () => {
    expect(describeApiError('nope')).toBe('Copy generation failed.')
  })
})

describe('getAnthropicApiKey', () => {
  const original = process.env.ANTHROPIC_API_KEY

  afterEach(() => {
    if (original === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = original
  })

  test('returns null when unset, so the route can refuse cleanly', () => {
    delete process.env.ANTHROPIC_API_KEY

    expect(getAnthropicApiKey()).toBeNull()
  })

  test('returns null for whitespace, which is what an empty .env line gives', () => {
    process.env.ANTHROPIC_API_KEY = '   '

    expect(getAnthropicApiKey()).toBeNull()
  })

  test('trims a configured key', () => {
    process.env.ANTHROPIC_API_KEY = ' sk-ant-test '

    expect(getAnthropicApiKey()).toBe('sk-ant-test')
  })
})
