import { describe, expect, it } from 'vitest'
import { childCounterForDocument, childCounterInvoiceAddress } from './address'

describe('childCounterInvoiceAddress', () => {
  const branch = {
    child_counters: [{
      id: 'counter-1',
      name: 'Shop 01 Male',
      street1: 'Street A',
      street2: 'Building 2',
      city: 'Male',
      state_province: 'Kaafu',
      country: 'Maldives',
      postal_code: '20001',
    }],
  }

  it('returns the selected child counter structured address in header lines', () => {
    expect(childCounterInvoiceAddress(branch, { child_counter_id: 'counter-1' })).toEqual([
      'Street A, Building 2',
      'Male, Kaafu, Maldives, 20001',
    ])
  })

  it('returns null when the sale has no child counter', () => {
    expect(childCounterInvoiceAddress(branch, {})).toBeNull()
  })

  it('does not fall back to a branch address when the saved counter is missing', () => {
    expect(childCounterInvoiceAddress(branch, { child_counter_id: 'removed-counter' })).toEqual([])
  })

  it('resolves the selected counter contact details', () => {
    const branchWithContacts = {
      child_counters: [{
        id: 'counter-1',
        name: 'Shop 01 Male',
        phone: '+960 1234567',
        email: 'counter@example.com',
      }],
    }
    expect(childCounterForDocument(branchWithContacts, { child_counter_id: 'counter-1' })).toMatchObject({
      phone: '+960 1234567',
      email: 'counter@example.com',
    })
  })
})
