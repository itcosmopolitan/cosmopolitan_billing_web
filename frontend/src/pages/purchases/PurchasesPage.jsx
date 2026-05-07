import { useState, useEffect, useMemo, useCallback } from 'react'
import toast from 'react-hot-toast'
import { purchasesAPI, vendorsAPI, branchesAPI, itemsAPI } from '@/api'
import { useCan } from '@/auth/permissions'
import { fmt, exportToCSV } from '@/utils/helpers'
import { SectionHeader, Card, Tabs, SearchBar, Chip, KPICard, Modal, FormGroup, FormRow, EmptyState, AlertBar, PaginationBar, SortableHeader } from '@/components/ui'
import { unwrapPaged, DEFAULT_PAGE_SIZE, fetchAllList } from '@/utils/pagination'
import NewBillModal from './NewBillModal'

const TABS = [
  { id: 'bills',   label: 'Purchase Bills' },
  { id: 'orders',  label: 'Purchase Orders' },
  { id: 'grn',     label: 'GRN — Goods Received' },
  { id: 'returns', label: 'Vendor Returns' },
]

export default function PurchasesPage() {
  const can = useCan()
  const [tab, setTab]           = useState('bills')
  const [search, setSearch]     = useState('')
  const [statusF, setStatusF]   = useState('')
  const [vendorF, setVendorF]   = useState('')
  const [showDetail, setShowDetail] = useState(null)
  const [showPay, setShowPay]   = useState(null)
  const [showNewBill, setShowNewBill] = useState(false)
  const [showNewReturn, setShowNewReturn] = useState(false)
  const [returnDetail, setReturnDetail] = useState(null)
  const [bills, setBills]       = useState([])
  const [billTotal, setBillTotal] = useState(0)
  const [billSkip, setBillSkip] = useState(0)
  const [billLimit, setBillLimit] = useState(DEFAULT_PAGE_SIZE)
  const [billSortBy, setBillSortBy] = useState('created_at')
  const [billSortOrder, setBillSortOrder] = useState('desc')
  const [purchaseSummary, setPurchaseSummary] = useState(null)
  const [returns, setReturns]   = useState([])
  const [retTotal, setRetTotal] = useState(0)
  const [retSkip, setRetSkip] = useState(0)
  const [retLimit, setRetLimit] = useState(DEFAULT_PAGE_SIZE)
  const [retSortBy, setRetSortBy] = useState('created_at')
  const [retSortOrder, setRetSortOrder] = useState('desc')
  const [vendors, setVendors]   = useState([])
  const [branches, setBranches] = useState([])
  const [items, setItems]       = useState([])
  const [loading, setLoading]   = useState(true)
  const [listVersion, setListVersion] = useState(0)
  const [payAmt, setPayAmt]     = useState('')
  const [payRef, setPayRef]     = useState('')

  const [newBill, setNewBill]   = useState({ vendorId: '', branchId: '', billDate: new Date().toISOString().split('T')[0], dueDate: '', items: [{ itemId: '', qty: '', cost: '' }], discount: 0, notes: '' })
  const patchBill = (k, v) => setNewBill((b) => ({ ...b, [k]: v }))
  const patchBillItem = (i, k, v) => setNewBill((b) => ({ ...b, items: b.items.map((it, idx) => idx === i ? { ...it, [k]: v } : it) }))

  const [newReturn, setNewReturn] = useState({ billId: '', reason: 'Defective', items: [{ itemId: '', name: '', originalQty: '', returnQty: '', cost: '' }], notes: '' })
  const patchReturn = (k, v) => setNewReturn((r) => ({ ...r, [k]: v }))
  const patchReturnItem = (i, k, v) => setNewReturn((r) => ({ ...r, items: r.items.map((it, idx) => idx === i ? { ...it, [k]: v } : it) }))

  const loadMasters = useCallback(async () => {
    try {
      const branchId = 'br-001'
      const [vendorsData, branchesData, itemsData] = await Promise.all([
        fetchAllList(vendorsAPI.list).catch(() => []),
        fetchAllList(branchesAPI.list).catch(() => []),
        fetchAllList(itemsAPI.list, { branch_id: branchId }).catch(() => []),
      ])
      setVendors(vendorsData || [])
      setBranches(branchesData || [])
      setItems(itemsData || [])
    } catch (err) {
      console.error('Failed to fetch masters:', err)
    }
  }, [])

  useEffect(() => {
    loadMasters()
  }, [loadMasters])

  useEffect(() => {
    setBillSkip(0)
  }, [search, statusF, vendorF])

  useEffect(() => {
    if (tab !== 'bills') {
      setLoading(false)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        const raw = await purchasesAPI.list({
          skip: billSkip,
          limit: billLimit,
          sort_by: billSortBy,
          sort_order: billSortOrder,
          search: search || undefined,
          status: statusF || undefined,
          vendor_id: vendorF || undefined,
        })
        const { items, total, summary } = unwrapPaged(raw)
        if (!cancelled) {
          setBills(items || [])
          setBillTotal(total)
          setPurchaseSummary(summary)
        }
      } catch (err) {
        console.error('Failed to fetch purchases:', err)
        if (!cancelled) {
          setBills([])
          setBillTotal(0)
          setPurchaseSummary(null)
        }
        toast.error('Failed to load purchases data')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [tab, billSkip, billLimit, search, statusF, vendorF, listVersion, billSortBy, billSortOrder])

  useEffect(() => {
    if (tab !== 'returns') {
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const raw = await purchasesAPI.returns.list({
          skip: retSkip,
          limit: retLimit,
          sort_by: retSortBy,
          sort_order: retSortOrder,
        })
        const { items, total } = unwrapPaged(raw)
        if (!cancelled) {
          setReturns(items || [])
          setRetTotal(total)
        }
      } catch {
        if (!cancelled) {
          setReturns([])
          setRetTotal(0)
        }
      }
    })()
    return () => { cancelled = true }
  }, [tab, retSkip, retLimit, listVersion, retSortBy, retSortOrder])

  // Tab-aware sort handler — both bills and returns tabs use this with a
  // closure over the right state setters. defaultOrder lets columns like
  // money / dates start descending when first clicked.
  const toggleSort = (currentBy, currentOrder, setBy, setOrder, setSkip, key, defaultOrder = 'asc') => {
    setSkip(0)
    if (currentBy === key) {
      setOrder(currentOrder === 'asc' ? 'desc' : 'asc')
      return
    }
    setBy(key)
    setOrder(defaultOrder)
  }

  const totals = useMemo(() => ({
    total:   purchaseSummary?.amountTotal ?? 0,
    paid:    purchaseSummary?.collectedPaid ?? 0,
    pending: purchaseSummary?.pendingBalance ?? 0,
    overdue: purchaseSummary?.overdueCount ?? 0,
  }), [purchaseSummary])

  const recordPayment = async () => {
    if (!payAmt || Number(payAmt) <= 0) { toast.error('Enter valid amount'); return }
    try {
      await purchasesAPI.payment(showPay.id, { amount: Number(payAmt), mode: 'NEFT', ref: payRef })
      setListVersion((v) => v + 1)
      toast.success(`Payment of ${fmt(payAmt)} recorded`)
      setShowPay(null)
      setPayAmt('')
      setPayRef('')
    } catch (err) {
      console.error('Failed to record payment:', err)
      toast.error('Failed to record payment')
    }
  }

  const saveNewBill = async () => {
    if (!newBill.vendorId) { toast.error('Select a vendor'); return }
    const billItems = newBill.items.filter((i) => i.itemId && i.qty)
    if (billItems.length === 0) { toast.error('Add at least one item'); return }

    try {
      const mapped = billItems.map((i) => {
        const item = items.find((x) => x.id === i.itemId)
        return {
          item_id: i.itemId,
          name: item?.name || '',
          qty: Number(i.qty),
          cost: Number(i.cost || item?.costPrice || 0),
          tax_rate: item?.taxRate || 0,
          line_total: Number(i.qty) * Number(i.cost || item?.costPrice || 0),
        }
      })

      const payload = {
        vendor_id: newBill.vendorId,
        branch_id: newBill.branchId || branches[0]?.id,
        date: newBill.billDate,
        due_date: newBill.dueDate,
        items: mapped,
        discount: Number(newBill.discount) || 0,
      }

      await purchasesAPI.create(payload)
      setListVersion((v) => v + 1)
      loadMasters()
      toast.success('Purchase bill created successfully')
      setShowNewBill(false)
      setNewBill({ vendorId: '', branchId: '', billDate: new Date().toISOString().split('T')[0], dueDate: '', items: [{ itemId: '', qty: '', cost: '' }], discount: 0, notes: '' })
    } catch (err) {
      console.error('Failed to save bill:', err)
      toast.error('Failed to create purchase bill')
    }
  }

  const saveNewReturn = async () => {
    if (!newReturn.billId) { toast.error('Select a bill'); return }
    const returnItems = newReturn.items.filter((i) => i.name && Number(i.returnQty) > 0)
    if (returnItems.length === 0) { toast.error('Add at least one item with return qty > 0'); return }

    try {
      const bill = bills.find((b) => b.id === newReturn.billId)
      if (!bill) { toast.error('Bill not found'); return }

      const mapped = returnItems.map((i) => {
        const item = items.find((x) => x.id === i.itemId)
        return {
          item_id: i.itemId,
          name: i.name || item?.name || '',
          original_qty: Number(i.originalQty || 0),
          return_qty: Number(i.returnQty),
          cost: Number(i.cost || item?.costPrice || 0),
          tax_rate: item?.taxRate || 0,
        }
      })

      const payload = {
        bill_id: newReturn.billId,
        vendor_id: bill.vendorId,
        reason: newReturn.reason,
        items: mapped,
        notes: newReturn.notes,
      }

      await purchasesAPI.returns.create(payload)
      setListVersion((v) => v + 1)
      toast.success('Vendor return created successfully')
      setShowNewReturn(false)
      setNewReturn({ billId: '', reason: 'Defective', items: [{ itemId: '', name: '', originalQty: '', returnQty: '', cost: '' }], notes: '' })
    } catch (err) {
      console.error('Failed to save return:', err)
      toast.error('Failed to create vendor return')
    }
  }

  const approveReturn = async (returnId) => {
    try {
      await purchasesAPI.returns.approve(returnId)
      setListVersion((v) => v + 1)
      toast.success('Vendor return approved')
    } catch (err) {
      console.error('Failed to approve return:', err)
      toast.error('Failed to approve vendor return')
    }
  }

  if (loading) {
    return <div className="page-container"><div style={{padding: 40, textAlign: 'center'}}>Loading purchases...</div></div>
  }

  return (
    <div className="page-container">
      <SectionHeader title="Purchase Management" subtitle="Vendor bills, purchase orders, GRN, and payments">
        <button className="btn btn-secondary btn-sm" onClick={() => {
          const exportData = bills.map(b => ({
            'Bill Number': b.number || b.id,
            'Vendor': b.vendorName || '—',
            'Bill Date': b.date || '—',
            'Due Date': b.due_date || '—',
            'Amount (₹)': b.total || 0,
            'Paid (₹)': b.paidAmount || 0,
            'Outstanding (₹)': (b.total || 0) - (b.paidAmount || 0),
            'Status': (b.status || '—').toUpperCase(),
          }))
          exportToCSV(exportData, `Purchases_${new Date().toISOString().split('T')[0]}.csv`)
          toast.success('Purchases exported')
        }}>↓ Export</button>
        <button className="btn btn-secondary btn-sm" onClick={() => toast('New PO creation coming soon')}>+ New PO</button>
        {can('purchases.create') && (
          <button className="btn btn-primary btn-sm" onClick={() => setShowNewBill(true)}>+ New Bill</button>
        )}
      </SectionHeader>

      <div className="grid-kpi" style={{ marginBottom: 20 }}>
        <KPICard label="Total Purchases (Apr)" value={fmt(totals.total)} color="var(--purple)" icon="📦" />
        <KPICard label="Paid"                  value={fmt(totals.paid)}  color="var(--green)"  icon="✅" />
        <KPICard label="Outstanding Payables"  value={fmt(totals.pending)} color="var(--amber)" icon="💳" />
        <KPICard label="Overdue Bills"         value={totals.overdue}    color="var(--red)"    icon="⚠️" />
      </div>

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'bills' && (
        <>
          <div className="filter-bar">
            <SearchBar value={search} onChange={setSearch} placeholder="Search bill #, vendor…" />
            <select className="form-input" style={{ width: 140 }} value={statusF} onChange={(e) => setStatusF(e.target.value)}>
              <option value="">All Statuses</option>
              {['paid','pending','partial','overdue'].map((s) => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
            </select>
            <select className="form-input" style={{ width: 180 }} value={vendorF} onChange={(e) => setVendorF(e.target.value)}>
              <option value="">All Vendors</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>
          <Card bodyPadding={false}>
            {bills.length === 0 ? <EmptyState icon="📋" title="No bills found" /> : (
              <table className="data-table">
                <thead>
                  <tr>
                    <SortableHeader label="Bill #" sortKey="number" sortBy={billSortBy} sortOrder={billSortOrder} onSort={(k) => toggleSort(billSortBy, billSortOrder, setBillSortBy, setBillSortOrder, setBillSkip, k, 'desc')} />
                    <SortableHeader label="Vendor" sortKey="vendor_name" sortBy={billSortBy} sortOrder={billSortOrder} onSort={(k) => toggleSort(billSortBy, billSortOrder, setBillSortBy, setBillSortOrder, setBillSkip, k)} />
                    <SortableHeader label="Branch" sortKey="branch_id" sortBy={billSortBy} sortOrder={billSortOrder} onSort={(k) => toggleSort(billSortBy, billSortOrder, setBillSortBy, setBillSortOrder, setBillSkip, k)} />
                    <SortableHeader label="Date" sortKey="date" sortBy={billSortBy} sortOrder={billSortOrder} onSort={(k) => toggleSort(billSortBy, billSortOrder, setBillSortBy, setBillSortOrder, setBillSkip, k, 'desc')} />
                    <SortableHeader label="Due Date" sortKey="due_date" sortBy={billSortBy} sortOrder={billSortOrder} onSort={(k) => toggleSort(billSortBy, billSortOrder, setBillSortBy, setBillSortOrder, setBillSkip, k, 'desc')} />
                    <SortableHeader label="Total" sortKey="total" sortBy={billSortBy} sortOrder={billSortOrder} onSort={(k) => toggleSort(billSortBy, billSortOrder, setBillSortBy, setBillSortOrder, setBillSkip, k, 'desc')} className="text-right" align="right" />
                    <SortableHeader label="Paid" sortKey="paid_amount" sortBy={billSortBy} sortOrder={billSortOrder} onSort={(k) => toggleSort(billSortBy, billSortOrder, setBillSortBy, setBillSortOrder, setBillSkip, k, 'desc')} className="text-right" align="right" />
                    <SortableHeader label="Balance" sortKey="balance_due" sortBy={billSortBy} sortOrder={billSortOrder} onSort={(k) => toggleSort(billSortBy, billSortOrder, setBillSortBy, setBillSortOrder, setBillSkip, k)} className="text-right" align="right" />
                    <SortableHeader label="Status" sortKey="status" sortBy={billSortBy} sortOrder={billSortOrder} onSort={(k) => toggleSort(billSortBy, billSortOrder, setBillSortBy, setBillSortOrder, setBillSkip, k)} />
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {bills.map((b) => (
                    <tr key={b.id}>
                      <td><span className="mono" style={{ color: 'var(--purple)', fontSize: 12 }}>{b.number}</span></td>
                      <td><div style={{ fontWeight: 500, color: 'var(--text-primary)', fontSize: 13 }}>{b.vendorName || 'N/A'}</div></td>
                      <td style={{ fontSize: 12 }}>{b.branchName || b.branchId || 'N/A'}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{b.date}</td>
                      <td style={{ fontSize: 12, color: b.status === 'overdue' ? 'var(--red)' : 'var(--text-muted)' }}>{b.dueDate || '—'}</td>
                      <td className="text-right mono" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{fmt(b.total || 0)}</td>
                      <td className="text-right mono" style={{ color: 'var(--green)' }}>{fmt(b.paidAmount || 0)}</td>
                      <td className="text-right mono" style={{ color: (b.total || 0) - (b.paidAmount || 0) > 0 ? 'var(--red)' : 'var(--green)' }}>{fmt((b.total || 0) - (b.paidAmount || 0))}</td>
                      <td><Chip status={b.status} /></td>
                      <td>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button className="btn btn-ghost btn-xs" onClick={() => setShowDetail(b)}>View</button>
                          {b.status !== 'paid' && can('purchases.edit') && <button className="btn btn-primary btn-xs" onClick={() => { setShowPay(b); setPayAmt(String((b.total || 0) - (b.paidAmount || 0))) }}>Pay</button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <PaginationBar
              total={billTotal}
              skip={billSkip}
              limit={billLimit}
              onSkipChange={setBillSkip}
              onLimitChange={setBillLimit}
              disabled={loading}
            />
          </Card>
        </>
      )}

      {tab === 'grn' && (
        <Card title="Goods Received Notes" bodyPadding={false}>
          {bills.length === 0 ? (
            <EmptyState icon="📥" title="No GRNs" desc="Goods received notes will appear here" />
          ) : (
            <table className="data-table">
              <thead><tr><th>GRN #</th><th>Vendor</th><th>Branch</th><th>Date</th><th>Items</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {bills.map((b) => (
                  <tr key={b.id}>
                    <td className="mono" style={{ fontSize: 12, color: 'var(--teal)' }}>GRN-{b.number?.slice(-4) || b.id}</td>
                    <td style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{b.vendorName}</td>
                    <td style={{ fontSize: 12 }}>{b.branchName}</td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{b.date}</td>
                    <td style={{ fontSize: 12 }}>{(b.items || []).length} items</td>
                    <td><Chip status="received" label="Received" /></td>
                    <td><button className="btn btn-ghost btn-xs" onClick={() => setShowDetail(b)}>View</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {tab === 'orders' && (
        <EmptyState icon="📄" title="No purchase orders" desc="Purchase orders will appear here once created" action={<button className="btn btn-primary btn-sm" onClick={() => toast('PO creation coming soon')}>+ Create PO</button>} />
      )}

      {tab === 'returns' && (
        <>
          <Card title="Vendor Returns" bodyPadding={false}>
            {returns.length === 0 ? (
              <EmptyState icon="↩️" title="No vendor returns" desc="Vendor return notes will appear here once created" action={can('purchases.create') ? <button className="btn btn-primary btn-sm" onClick={() => setShowNewReturn(true)}>+ Create Return</button> : null} />
            ) : (
              <>
                <table className="data-table">
                  <thead>
                    <tr>
                      <SortableHeader label="Return #" sortKey="number" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k, 'desc')} />
                      <SortableHeader label="Bill #" sortKey="bill_number" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k, 'desc')} />
                      <SortableHeader label="Vendor" sortKey="vendor_name" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k)} />
                      <SortableHeader label="Date" sortKey="date" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k, 'desc')} />
                      <SortableHeader label="Total" sortKey="total" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k, 'desc')} className="text-right" align="right" />
                      <SortableHeader label="Credit" sortKey="credited_amount" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k, 'desc')} className="text-right" align="right" />
                      <th>Reason</th>
                      <SortableHeader label="Status" sortKey="status" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k)} />
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {returns.map((r) => (
                      <tr key={r.id}>
                        <td className="mono" style={{ color: 'var(--pink)', fontSize: 12 }}>{r.number}</td>
                        <td className="mono" style={{ color: 'var(--purple)', fontSize: 12 }}>{r.billNumber}</td>
                        <td style={{ fontWeight: 500, color: 'var(--text-primary)', fontSize: 13 }}>{r.vendorName}</td>
                        <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.date}</td>
                        <td className="text-right mono" style={{ fontWeight: 600 }}>{fmt(r.total)}</td>
                        <td className="text-right mono" style={{ color: 'var(--amber)' }}>{fmt(r.creditedAmount)}</td>
                        <td style={{ fontSize: 12 }}><Chip label={r.reason} /></td>
                        <td><Chip status={r.status} /></td>
                        <td>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button className="btn btn-ghost btn-xs" onClick={() => setReturnDetail(r)}>View</button>
                            {r.status !== 'paid' && can('purchases.edit') && <button className="btn btn-primary btn-xs" onClick={() => approveReturn(r.id)}>Approve</button>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {can('purchases.create') && (
                  <div style={{ padding: '16px 20px', borderTop: '1px solid var(--border)', textAlign: 'center' }}>
                    <button className="btn btn-primary btn-sm" onClick={() => setShowNewReturn(true)}>+ Create Return</button>
                  </div>
                )}
                <PaginationBar
                  total={retTotal}
                  skip={retSkip}
                  limit={retLimit}
                  onSkipChange={setRetSkip}
                  onLimitChange={setRetLimit}
                />
              </>
            )}
          </Card>
        </>
      )}

      {/* Bill Detail Modal */}
      <Modal open={!!showDetail} onClose={() => setShowDetail(null)} title={`Purchase Bill — ${showDetail?.number}`} icon="📋" size="lg"
        footer={<>
          <button className="btn btn-secondary" onClick={() => setShowDetail(null)}>Close</button>
          <button className="btn btn-secondary" onClick={() => toast('Printing…')}>🖨 Print</button>
          {showDetail?.status !== 'paid' && <button className="btn btn-primary" onClick={() => { setShowPay(showDetail); setShowDetail(null) }}>Record Payment</button>}
        </>}>
        {showDetail && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 18 }}>
              {[
                { label: 'Vendor', value: showDetail.vendorName },
                { label: 'Branch', value: showDetail.branchName },
                { label: 'Bill Date', value: showDetail.date },
                { label: 'Due Date', value: showDetail.dueDate || '—' },
                { label: 'Payment Ref', value: showDetail.paymentRef || '—' },
                { label: 'Status', value: <Chip status={showDetail.status} /> },
              ].map((r) => (
                <div key={r.label} style={{ padding: '10px 12px', background: 'var(--bg-raised)', borderRadius: 8 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>{r.label}</div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{r.value}</div>
                </div>
              ))}
            </div>
            <table className="data-table" style={{ marginBottom: 14 }}>
              <thead><tr><th>Item</th><th className="text-right">Qty</th><th className="text-right">Cost</th><th className="text-right">GST</th><th className="text-right">Total</th></tr></thead>
              <tbody>
                {(showDetail.items || []).map((item, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{item.name}</td>
                    <td className="text-right mono">{item.qty}</td>
                    <td className="text-right mono">{fmt(item.cost)}</td>
                    <td className="text-right mono">{item.taxRate}%</td>
                    <td className="text-right mono">{fmt(item.lineTotal || item.qty * item.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'flex-end' }}>
              <div style={{ display: 'flex', gap: 80, fontSize: 13, color: 'var(--text-muted)' }}><span>Subtotal</span><span className="mono">{fmt(showDetail.subtotal || 0)}</span></div>
              <div style={{ display: 'flex', gap: 80, fontSize: 13, color: 'var(--text-muted)' }}><span>GST</span><span className="mono">{fmt(showDetail.taxTotal || 0)}</span></div>
              <div style={{ display: 'flex', gap: 80, fontSize: 17, fontWeight: 700 }}><span>Total</span><span className="mono" style={{ color: 'var(--purple)' }}>{fmt(showDetail.total || 0)}</span></div>
              <div style={{ display: 'flex', gap: 80, fontSize: 13, color: 'var(--green)' }}><span>Paid</span><span className="mono">{fmt(showDetail.paidAmount || 0)}</span></div>
            </div>
          </>
        )}
      </Modal>

      {/* Payment Modal */}
      <Modal open={!!showPay} onClose={() => setShowPay(null)} title="Record Vendor Payment" icon="💳" size="sm"
        footer={<>
          <button className="btn btn-secondary" onClick={() => setShowPay(null)}>Cancel</button>
          <button className="btn btn-primary" onClick={recordPayment}>Record Payment</button>
        </>}>
        {showPay && (
          <>
            <AlertBar type="blue" icon="ℹ">Balance: <strong>{fmt((showPay.total || 0) - (showPay.paidAmount || 0))}</strong> — {showPay.vendorName}</AlertBar>
            <div style={{ height: 14 }} />
            <FormGroup label="Amount Paid (₹)" required>
              <input className="form-input" type="number" value={payAmt} onChange={(e) => setPayAmt(e.target.value)} autoFocus />
            </FormGroup>
            <FormGroup label="Payment Mode">
              <select className="form-input">
                {['NEFT / RTGS', 'Cheque', 'Cash', 'UPI'].map((m) => <option key={m}>{m}</option>)}
              </select>
            </FormGroup>
            <FormGroup label="Transaction Ref / Cheque #">
              <input className="form-input" value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="e.g. NEFT-20240416-002" />
            </FormGroup>
          </>
        )}
      </Modal>

      <NewBillModal
        open={showNewBill}
        onClose={() => setShowNewBill(false)}
        onSave={saveNewBill}
        newBill={newBill}
        patchBill={patchBill}
        patchBillItem={patchBillItem}
        addItem={() => setNewBill((b) => ({ ...b, items: [...b.items, { itemId: '', qty: '', cost: '' }] }))}
        removeItem={(i) => setNewBill((b) => ({ ...b, items: b.items.filter((_, idx) => idx !== i) }))}
        vendors={vendors}
        branches={branches}
        items={items}
      />

      {/* Return Detail Modal */}
      <Modal open={!!returnDetail} onClose={() => setReturnDetail(null)} title={`Vendor Return — ${returnDetail?.number}`} icon="↩️" size="lg"
        footer={<>
          <button className="btn btn-secondary" onClick={() => setReturnDetail(null)}>Close</button>
          {returnDetail?.status !== 'paid' && <button className="btn btn-primary" onClick={() => { approveReturn(returnDetail.id); setReturnDetail(null) }}>Approve Credit</button>}
        </>}>
        {returnDetail && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 18 }}>
              {[
                { label: 'Original Bill', value: returnDetail.billNumber },
                { label: 'Vendor', value: returnDetail.vendorName },
                { label: 'Return Date', value: returnDetail.date },
                { label: 'Reason', value: returnDetail.reason },
                { label: 'Status', value: <Chip status={returnDetail.status} /> },
                { label: 'Credited', value: fmt(returnDetail.creditedAmount) },
              ].map((r) => (
                <div key={r.label} style={{ padding: '10px 12px', background: 'var(--bg-raised)', borderRadius: 8 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>{r.label}</div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{r.value}</div>
                </div>
              ))}
            </div>
            <table className="data-table" style={{ marginBottom: 14 }}>
              <thead><tr><th>Item</th><th className="text-right">Qty Returned</th><th className="text-right">Cost</th><th className="text-right">Total</th></tr></thead>
              <tbody>
                {(returnDetail.items || []).map((item, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{item.name}</td>
                    <td className="text-right mono">{item.returnQty}</td>
                    <td className="text-right mono">{fmt(item.cost)}</td>
                    <td className="text-right mono">{fmt(item.lineTotal || item.returnQty * item.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'flex-end' }}>
              <div style={{ display: 'flex', gap: 80, fontSize: 13, color: 'var(--text-muted)' }}><span>Subtotal</span><span className="mono">{fmt(returnDetail.subtotal || 0)}</span></div>
              <div style={{ display: 'flex', gap: 80, fontSize: 13, color: 'var(--text-muted)' }}><span>GST</span><span className="mono">{fmt(returnDetail.taxTotal || 0)}</span></div>
              <div style={{ display: 'flex', gap: 80, fontSize: 17, fontWeight: 700 }}><span>Total Credit</span><span className="mono" style={{ color: 'var(--pink)' }}>{fmt(returnDetail.total || 0)}</span></div>
            </div>
          </>
        )}
      </Modal>

      {/* New Vendor Return Modal */}
      <Modal open={showNewReturn} onClose={() => setShowNewReturn(false)} title="Create Vendor Return" icon="↩️" size="lg"
        footer={<>
          <button className="btn btn-secondary" onClick={() => setShowNewReturn(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={saveNewReturn}>Create Return</button>
        </>}>
        <FormRow>
          <FormGroup label="Select Bill" required>
            <select className="form-input" value={newReturn.billId} onChange={(e) => patchReturn('billId', e.target.value)}>
              <option value="">Choose a bill to return…</option>
              {bills.map((b) => <option key={b.id} value={b.id}>{b.number} — {b.vendorName} ({fmt(b.total)})</option>)}
            </select>
          </FormGroup>
          <FormGroup label="Return Reason" required>
            <select className="form-input" value={newReturn.reason} onChange={(e) => patchReturn('reason', e.target.value)}>
              {['Defective', 'Overstocked', 'Wrong Item', 'Quality Issue', 'Damaged', 'Other'].map((r) => <option key={r}>{r}</option>)}
            </select>
          </FormGroup>
        </FormRow>
        <div className="form-label" style={{ marginBottom: 8 }}>Items to Return</div>
        {newReturn.items.map((item, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.5fr 60px 60px 80px auto', gap: 8, marginBottom: 6 }}>
            <input className="form-input" placeholder="Item name" value={item.name} onChange={(e) => patchReturnItem(i, 'name', e.target.value)} />
            <input className="form-input" type="number" placeholder="Original" value={item.originalQty} onChange={(e) => patchReturnItem(i, 'originalQty', e.target.value)} title="Original qty from bill" />
            <input className="form-input" type="number" placeholder="Return" value={item.returnQty} onChange={(e) => patchReturnItem(i, 'returnQty', e.target.value)} />
            <input className="form-input" type="number" placeholder="Cost ₹" value={item.cost} onChange={(e) => patchReturnItem(i, 'cost', e.target.value)} />
            <button className="btn btn-ghost btn-sm" onClick={() => setNewReturn((r) => ({ ...r, items: r.items.filter((_, idx) => idx !== i) }))}>✕</button>
          </div>
        ))}
        <button className="btn btn-ghost btn-sm" style={{ marginBottom: 14 }} onClick={() => setNewReturn((r) => ({ ...r, items: [...r.items, { itemId: '', name: '', originalQty: '', returnQty: '', cost: '' }] }))}>+ Add item</button>
        <FormGroup label="Notes">
          <textarea className="form-input" style={{ height: 60 }} value={newReturn.notes} onChange={(e) => patchReturn('notes', e.target.value)} placeholder="Any additional notes…" />
        </FormGroup>
      </Modal>
    </div>
  )
}
