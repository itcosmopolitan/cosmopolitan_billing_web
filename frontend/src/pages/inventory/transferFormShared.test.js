import { describe, expect, it } from 'vitest'
import { buildTransferPayload, formFromTransfer } from './transferFormShared'

describe('transfer cost price', () => {
  it('loads a saved line cost price into edit state', () => {
    const form = formFromTransfer({
      from_branch_id: 'source',
      to_branch_id: 'destination',
      items: [{ item_id: 'item-1', qty: 3, cost_price: 12.5 }],
    })

    expect(form.items[0].cost_price).toBe('12.5')
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
})
