'use client'

import { useCallback, useRef } from 'react'

import type { ContentIdea } from '@/lib/content-studio/suggestionTypes'

import { suggest } from './api'
import { CHANNEL_LABELS } from './labels'
import SuggestionChips, { type Suggestion } from './SuggestionChips'

type IdeaPickerProps = {
  onPick: (idea: ContentIdea) => void
}

/**
 * "Need an idea?" on an empty brief (docs/CONTENT_STUDIO_SUGGESTIONS_PLAN.md, F3): ideas
 * drawn from the brand, upcoming newsletter topics and what was published recently.
 * Asked for on demand; picking one prefills the brief, which stays fully editable.
 */
export default function IdeaPicker({ onPick }: IdeaPickerProps) {
  const ideas = useRef(new Map<string, ContentIdea>())

  const load = useCallback(async (fresh: boolean): Promise<Suggestion[]> => {
    const { suggestions } = await suggest({ kind: 'content_ideas', fresh })
    ideas.current = new Map(suggestions.map((idea) => [idea.title, idea]))
    return suggestions.map((idea) => ({
      key: idea.title,
      label: idea.title,
      detail: [idea.angle || idea.topic, idea.channels.map((channel) => CHANNEL_LABELS[channel]).join(' · ')].filter(Boolean).join(' — '),
      value: idea.title,
    }))
  }, [])

  const pick = (title: string) => {
    const idea = ideas.current.get(title)
    if (idea) onPick(idea)
  }

  return <SuggestionChips title="Need an idea?" startLabel="Suggest ideas" load={load} onPick={pick} />
}
