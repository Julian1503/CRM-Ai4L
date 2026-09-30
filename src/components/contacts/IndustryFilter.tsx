'use client'

import React, { useEffect, useState } from 'react'

import { readErrorMessage } from './useRemoteSearch'

/**
 * Industry (organisation sector) filter.
 *
 * Options are the distinct `organisations.industry` values from
 * `GET /api/organisations?facet=industry`, not the industries of the rows on screen.
 * A value selected from the URL that the facet no longer lists is kept as an option,
 * so the control never silently shows "All" while a filter is applied.
 */

export interface IndustryFilterProps {
  value: string
  onChange: (value: string) => void
  /** Bump to refetch the options, e.g. after an industry is edited in Settings. */
  reloadKey?: number
  /** Class names from the host, so the select matches its siblings. */
  classNames?: { group?: string; label?: string; select?: string }
}

export default function IndustryFilter({ value, onChange, reloadKey = 0, classNames = {} }: IndustryFilterProps) {
  const [industries, setIndustries] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()

    const load = async () => {
      try {
        const response = await fetch('/api/organisations?facet=industry', { signal: controller.signal })

        if (!response.ok) throw new Error(await readErrorMessage(response, 'Could not load industries'))

        const body = (await response.json()) as { industries?: unknown }
        setIndustries(Array.isArray(body.industries) ? body.industries.filter((item): item is string => typeof item === 'string') : [])
        setError(null)
      } catch (caught) {
        if ((caught as Error).name === 'AbortError') return
        setIndustries([])
        setError(caught instanceof Error ? caught.message : 'Could not load industries.')
      }
    }

    void load()
    return () => controller.abort()
  }, [reloadKey])

  const hasValue = value !== ''
  const listed = industries.some((industry) => industry.toLowerCase() === value.trim().toLowerCase())
  const options = hasValue && !listed ? [value, ...industries] : industries

  return (
    <div className={classNames.group}>
      <label htmlFor="industry-filter" className={classNames.label}>
        Industry
      </label>
      <select
        id="industry-filter"
        data-testid="industry-filter"
        className={classNames.select}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={error ? 'industry-filter-error' : undefined}
      >
        <option value="">{error ? 'Industries unavailable' : 'All industries'}</option>
        {options.map((industry) => (
          <option key={industry} value={industry}>
            {industry}
          </option>
        ))}
      </select>
      {error && (
        <span id="industry-filter-error" hidden>
          {error}
        </span>
      )}
    </div>
  )
}
