/**
 * @jest-environment node
 *
 * Imports against the real database (audit H9, P3, T2).
 */
import type { MappedContactRow } from '@/lib/excelParser'
import { describeIntegration, must, serviceClient, uniqueTag } from '@/test/integration'

import { importContacts, ImportPreviewStaleError, previewContactImport } from './import'

jest.setTimeout(60_000)

function row(email: string, extra: Record<string, unknown> = {}): MappedContactRow {
  return { isValid: true, data: { firstName: 'Ada', lastName: 'L', email, ...extra } as never }
}

describeIntegration('import_contacts against Postgres', () => {
  it('keeps an existing customer a customer when the file has no customer column (H9)', async () => {
    const db = serviceClient()
    const email = `${uniqueTag('cust')}@example.test`
    await must(db.from('contacts').insert({ first_name: 'Ada', last_name: 'L', email, status: 'customer', is_customer: true }).select('id'))

    await importContacts(db, [row(email, { position: 'CTO' })])

    const after = await must(db.from('contacts').select('status, is_customer, position').eq('email', email).is('deleted_at', null).single())
    expect(after).toEqual({ status: 'customer', is_customer: true, position: 'CTO' })
  })

  it('applies an explicit "no" deliberately, and leaves a lead a lead', async () => {
    const db = serviceClient()
    const customer = `${uniqueTag('cust')}@example.test`
    const lead = `${uniqueTag('lead')}@example.test`
    await must(db.from('contacts').insert([
      { first_name: 'A', last_name: 'L', email: customer, status: 'customer', is_customer: true },
      { first_name: 'B', last_name: 'L', email: lead, status: 'lead' },
    ]).select('id'))

    await importContacts(db, [row(customer, { isCustomer: false }), row(lead, { isCustomer: false })])

    const rows = await must(db.from('contacts').select('email, status').in('email', [customer, lead]).is('deleted_at', null))
    expect(Object.fromEntries(rows.map((r) => [r.email, r.status]))).toEqual({ [customer]: 'prospect', [lead]: 'lead' })
  })

  it('defaults a new contact without a customer column to prospect', async () => {
    const db = serviceClient()
    const email = `${uniqueTag('new')}@example.test`

    await importContacts(db, [row(email)])

    expect((await must(db.from('contacts').select('status').eq('email', email).single())).status).toBe('prospect')
  })

  it('previews without writing, and the preview agrees with the import', async () => {
    const db = serviceClient()
    const existing = `${uniqueTag('prev')}@example.test`
    const fresh = `${uniqueTag('prev')}@example.test`
    await must(db.from('contacts').insert({ first_name: 'A', last_name: 'L', email: existing, status: 'customer', is_customer: true, subscribed_to_newsletter: true }).select('id'))

    const preview = await previewContactImport(db, [
      row(existing, { isCustomer: false, subscribedToNewsletter: false }),
      row(fresh),
      row(fresh),
    ])

    expect(preview).toMatchObject({ new: 1, changed: 1, duplicates: 1, leaving_customers: 1, withdrawing_newsletter: 1 })
    expect((await must(db.from('contacts').select('id').eq('email', fresh))).length).toBe(0)

    const result = await importContacts(db, [row(existing, { isCustomer: false, subscribedToNewsletter: false }), row(fresh), row(fresh)], preview.token)
    expect(result).toMatchObject({ inserted: 1, updated: 1, duplicates: 1 })
  })

  it('refuses to apply a preview that went stale', async () => {
    const db = serviceClient()
    const email = `${uniqueTag('stale')}@example.test`
    const { id } = await must(db.from('contacts').insert({ first_name: 'A', last_name: 'L', email }).select('id').single())
    const preview = await previewContactImport(db, [row(email, { position: 'CEO' })])

    await must(db.from('contacts').update({ notes: 'edited meanwhile' }).eq('id', id).select('id'))

    await expect(importContacts(db, [row(email, { position: 'CEO' })], preview.token)).rejects.toBeInstanceOf(ImportPreviewStaleError)
    expect((await must(db.from('contacts').select('position').eq('id', id).single())).position).toBeNull()
  })
})
