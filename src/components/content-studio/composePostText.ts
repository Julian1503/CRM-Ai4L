import type { RevisionContent } from '@/lib/content-studio/types'

type Composable = Pick<RevisionContent, 'body' | 'hashtags' | 'callToAction'>

/**
 * The post as one block of text: body, blank line, CTA, blank line, hashtags.
 *
 * A local mirror of the server's composer, used only for previews while editing and
 * for copy-to-clipboard. The text that is actually published comes from preflight
 * (`PublishPreflight.composedText`) and is shown verbatim in the publish dialog.
 * Empty sections are dropped so there are never stray blank lines.
 */
export function composePostText({ body, hashtags, callToAction }: Composable): string {
  const tags = hashtags
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .join(' ')

  return [body.trim(), (callToAction ?? '').trim(), tags].filter((section) => section.length > 0).join('\n\n')
}
