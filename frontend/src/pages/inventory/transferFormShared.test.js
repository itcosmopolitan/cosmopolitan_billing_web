import { describe, expect, it } from 'vitest'
import {
  buildTransferPayload,
  emptyTransfer,
  formFromTransfer,
  validateTransferForm,
} from './transferFormShared'
import { todayISO } from '@/utils/batchDates'

describe('transfer cost price', () => {
  it('loads a saved line cost price into edit state', () => {
    const form = formFromTransfer({
      from_branch_id: 'source',
      to_branch_id: 'destination',
      items: [{ item_id: 'item-1', qty: 3, cost_price: 12.5 }],
    })

    expect(form.items[0].cost_price).toBe('12.5')
    expect(form.items[0].qty).toBe('3')
  })

  it('includes the edited cost price in the saved transfer payload', () => {
    const payload = buildTransferPayload({
      from_branch_id: 'source',
      to_branch_id: 'destination',
      items: [{
        item_id: 'item-1',
        qty: '3',
        cost_price: '15.25',
        batchAllocation: [],
      }],
    }, [{ id: 'item-1', name: 'Test item', cost_price: 12.5 }])

    expect(payload.items[0]).toMatchObject({
      item_id: 'item-1',
      qty: 3,
      cost_price: 15.25,
    })
  })

  it('requires an expected dispatch date before a transfer can be saved', () => {
    const form = {
      from_branch_id: 'source',
      to_branch_id: 'destination',
      recorded_date: '2026-10-17',
      expected_date: '',
      items: [{ item_id: 'item-1', qty: '3', cost_price: '12.5', batchAllocation: [] }],
    }
    const items = [{ id: 'item-1', name: 'Test item', cost_price: 12.5 }]

    expect(validateTransferForm(form, items, {})).toEqual({
      ok: false,
      error: 'Select an expected dispatch date',
    })
    expect(validateTransferForm({ ...form, expected_date: '2026-10-20' }, items, {})).toEqual({ ok: true })
  })

  it('defaults the recorded date to today on a new transfer', () => {
    expect(emptyTransfer().recorded_date).toBe(todayISO())
  })

  it('requires a recorded date before a transfer can be saved', () => {
    const form = {
      from_branch_id: 'source',
      to_branch_id: 'destination',
      recorded_date: '',
      expected_date: '2026-10-20',
      items: [{ item_id: 'item-1', qty: '3', cost_price: '12.5', batchAllocation: [] }],
    }
    const items = [{ id: 'item-1', name: 'Test item', cost_price: 12.5 }]

    expect(validateTransferForm(form, items, {})).toEqual({
      ok: false,
      error: 'Select a recorded date',
    })
    expect(validateTransferForm({ ...form, recorded_date: '2026-10-17' }, items, {})).toEqual({ ok: true })
  })

  it('loads and sends the recorded date separately from the expected dispatch date', () => {
    const form = formFromTransfer({
      from_branch_id: 'source',
      to_branch_id: 'destination',
      recorded_date: '2026-10-17',
      expected_date: '2026-10-20',
      items: [{ item_id: 'item-1', qty: 3, cost_price: 12.5 }],
    })

    expect(form.recorded_date).toBe('2026-10-17')
    expect(form.expected_date).toBe('2026-10-20')

    const payload = buildTransferPayload(form, [{ id: 'item-1', name: 'Test item', cost_price: 12.5 }])
    expect(payload.recorded_date).toBe('2026-10-17')
    expect(payload.expected_date).toBe('2026-10-20')
  })
})
