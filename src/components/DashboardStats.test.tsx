import { render, screen } from '@testing-library/react'

import DashboardStats from './DashboardStats'

function renderStats(overrides: Partial<React.ComponentProps<typeof DashboardStats>> = {}) {
  render(
    <DashboardStats
      totalContacts={5202}
      customers={120}
      prospects={5082}
      newsletterSubscribers={5082}
      programSubscribers={5150}
      {...overrides}
    />
  )
}

/** Replaces matchMedia for one test, restoring it afterwards. */
function useMatchMedia(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: jest.fn().mockReturnValue({ matches }),
  })
}

describe('DashboardStats', () => {
  const original = window.matchMedia

  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: original,
    })
  })

  it('labels each card', () => {
    renderStats()

    for (const label of ['Total Contacts', 'Customers', 'Prospects', 'Newsletter']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  describe('derived percentages', () => {
    it('reports the customer share of all contacts, leads and subscriber share', () => {
      renderStats({
        totalContacts: 200,
        customers: 50,
        prospects: 150,
        newsletterSubscribers: 100,
        programSubscribers: 150,
      })

      expect(screen.getByText('25% of all contacts')).toBeInTheDocument()
      expect(screen.getByText('0 leads not yet qualified')).toBeInTheDocument()
      expect(screen.getByText('50% of contacts subscribed')).toBeInTheDocument()
    })

    it('shows 0% rather than NaN on an empty database', () => {
      // The first thing a new deployment renders. A NaN here is the classic
      // divide-by-zero that reaches production because nobody tested day one.
      renderStats({
        totalContacts: 0,
        customers: 0,
        prospects: 0,
        newsletterSubscribers: 0,
        programSubscribers: 0,
      })

      expect(screen.getByText('0% of all contacts')).toBeInTheDocument()
      expect(screen.getByText('0 leads not yet qualified')).toBeInTheDocument()
      expect(screen.getByText('0% of contacts subscribed')).toBeInTheDocument()
    })

    it('rounds rather than truncating', () => {
      renderStats({ totalContacts: 3, customers: 2, prospects: 1, newsletterSubscribers: 1 })

      expect(screen.getByText('67% of all contacts')).toBeInTheDocument()
    })
  })

  describe('reduced motion', () => {
    it('renders the real counts when the count-up is skipped', () => {
      // The animation writes into the same spans, so skipping it must not leave them
      // showing a stale or zero value.
      useMatchMedia(true)

      renderStats({ totalContacts: 5202, customers: 120, prospects: 5082, newsletterSubscribers: 4000 })

      expect(screen.getByText('5202')).toBeInTheDocument()
      expect(screen.getByText('120')).toBeInTheDocument()
      expect(screen.getByText('4000')).toBeInTheDocument()
    })

    it('derives the same figures when motion is allowed', () => {
      // The percentages come from JSX, not from the tween, so the two paths must agree.
      useMatchMedia(false)

      renderStats({ totalContacts: 7, customers: 1, prospects: 6, newsletterSubscribers: 3 })

      expect(screen.getByText('14% of all contacts')).toBeInTheDocument()
      expect(screen.getByText('0 leads not yet qualified')).toBeInTheDocument()
      expect(screen.getByText('43% of contacts subscribed')).toBeInTheDocument()
    })
  })

  describe('real statuses (UX P3.1)', () => {
    it('shows leads separately from prospects', () => {
      renderStats({ totalContacts: 10, customers: 2, prospects: 3, leads: 5 })

      expect(screen.getByText('3')).toBeInTheDocument()
      expect(screen.getByText('5 leads not yet qualified')).toBeInTheDocument()
      expect(screen.queryByText(/conversion rate/)).not.toBeInTheDocument()
    })

    it('says "lead" for exactly one', () => {
      renderStats({ leads: 1 })
      expect(screen.getByText('1 lead not yet qualified')).toBeInTheDocument()
    })
  })

  describe('unavailable counts (audit M2)', () => {
    it('shows dashes instead of zeros it never measured', () => {
      useMatchMedia(false)
      renderStats({ unavailable: true, totalContacts: 0, customers: 0 })

      expect(screen.getByText('Counts unavailable')).toBeInTheDocument()
      expect(screen.queryByText('0')).not.toBeInTheDocument()
      expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(5)
    })
  })
})
