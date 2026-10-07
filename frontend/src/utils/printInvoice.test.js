import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareInvoicePayload, prepareStockTransferPayload } from './printInvoice'

describe('prepareInvoicePayload for Sales Orders', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches complete order details from the Sales Orders endpoint when items are missing', async () => {
    const completeOrder = {
      id: 'sales-order-1',
      number: 'SO-0001',
      customerName: 'Customer',
      items: [{
        name: 'Item from order',
        qty: 2,
        price: 100,
        tax_rate: 8,
        discount: 10,
        packing: '1x15KG',
        unit: 'KG',
      }],
    }
    const fetch = vi.fn(async (url) => {
      if (url === '/api/v1/sales/orders/sales-order-1') {
        return { ok: true, json: async () => completeOrder }
      }
      if (url === '/api/v1/settings/organisation') {
        return { ok: false, json: async () => ({}) }
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })
    vi.stubGlobal('window', { localStorage: { getItem: () => null } })
    vi.stubGlobal('fetch', fetch)

    const payload = await prepareInvoicePayload(
      { id: 'sales-order-1', number: 'SO-0001', customerName: 'Customer' },
      {},
      { documentType: 'Sales Order' },
    )

    expect(fetch).toHaveBeenCalledWith('/api/v1/sales/orders/sales-order-1', expect.any(Object))
    expect(payload.documentType).toBe('Sales Order')
    expect(payload.sale.items).toEqual(completeOrder.items)
    expect(payload.sale.items[0]).toMatchObject({ packing: '1x15KG', unit: 'KG' })
  })
})

describe('prepareInvoicePayload for Purchase Orders', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('preserves inventory packing and unit values for the Invoice print template', async () => {
    const completeOrder = {
      id: 'purchase-order-1',
      number: 'PO-0001',
      vendorName: 'Vendor',
      items: [{
        name: 'Almond Flakes',
        qty: 1,
        cost: 100,
        taxRate: 8,
        packing: '1x15KG',
        unit: 'KG',
      }],
    }
    const fetch = vi.fn(async (url) => {
      if (url === '/api/v1/purchases/orders/purchase-order-1') {
        return { ok: true, json: async () => completeOrder }
      }
      if (url === '/api/v1/settings/organisation') {
        return { ok: false, json: async () => ({}) }
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    })
    vi.stubGlobal('window', { localStorage: { getItem: () => null } })
    vi.stubGlobal('fetch', fetch)

    const payload = await prepareInvoicePayload(
      { id: 'purchase-order-1', number: 'PO-0001', vendorName: 'Vendor' },
      {},
      { documentType: 'Purchase Order' },
    )

    expect(fetch).toHaveBeenCalledWith('/api/v1/purchases/orders/purchase-order-1', expect.any(Object))
    expect(payload.sale.items[0]).toMatchObject({
      price: 100,
      packing: '1x15KG',
      unit: 'KG',
    })
  })

  describe('prepareStockTransferPayload', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('loads transfer detail and preserves route, status, packing, units, and quantities', async () => {
      const transfer = {
        id: 'transfer-1',
        ref_number: 'TR-0001',
        from_branch_name: 'North',
        to_branch_name: 'South',
        items: [],
      }
      const fullTransfer = {
        ...transfer,
        status: 'transit',
        requested_by: 'Operator',
        items: [{
          name: 'Item from transfer',
          qty: 4,
          cost_price: 12.5,
          packing: '1x15KG',
          unit: 'KG',
        }],
      }
      const fetch = vi.fn(async (url) => {
        if (url === '/api/v1/transfers/transfer-1') {
          return { ok: true, json: async () => fullTransfer }
        }
        throw new Error(`Unexpected fetch URL: ${url}`)
      })
      vi.stubGlobal('window', { localStorage: { getItem: () => null } })
      vi.stubGlobal('fetch', fetch)

      const branch = { id: 'branch-1', name: 'North' }
      const payload = await prepareStockTransferPayload(transfer, branch)

      expect(fetch).toHaveBeenCalledWith('/api/v1/transfers/transfer-1', expect.any(Object))
      expect(payload.documentType).toBe('Stock Transfer')
      expect(payload.branch).toBe(branch)
      expect(payload.sale).toMatchObject({
        number: 'TR-0001',
        from_branch_name: 'North',
        to_branch_name: 'South',
        status: 'transit',
      })
      expect(payload.sale.items[0]).toMatchObject({
        name: 'Item from transfer',
        qty: 4,
        cost_price: 12.5,
        packing: '1x15KG',
        unit: 'KG',
      })
    })
  })
})
