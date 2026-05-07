import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { salesAPI, branchesAPI } from '@/api'
import { useCan } from '@/auth/permissions'
import { fmt, statusLabel, exportToCSV } from '@/utils/helpers'
import { SectionHeader, Card, Tabs, SearchBar, Chip, KPICard, Modal, FormGroup, EmptyState, Tag, AlertBar, PaginationBar, SortableHeader } from '@/components/ui'
import { unwrapPaged, DEFAULT_PAGE_SIZE } from '@/utils/pagination'
import { Receipt } from '@/components/Receipt'
import QuoteFormModal from './QuoteFormModal'

const TABS = [
  { id: 'invoices',  label: 'Invoices' },
  { id: 'orders',    label: 'Sales Orders' },
  { id: 'quotes',    label: 'Quotations' },
  { id: 'credit',    label: 'Credit Purchases' },
  { id: 'returns',   label: 'Credit Notes / Returns' },
]

export default function SalesPage() {
  const navigate = useNavigate()
  const can = useCan()
  const [tab, setTab]           = useState('invoices')
  const [search, setSearch]     = useState('')
  const [statusF, setStatusF]   = useState('')
  const [branchF, setBranchF]   = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [showDetail, setShowDetail] = useState(null)
  const [showPayment, setShowPayment] = useState(null)
  const [showReceipt, setShowReceipt] = useState(null)
  const [payAmt, setPayAmt]     = useState('')
  const [payMode, setPayMode]   = useState('bank_transfer')
  const [payRef, setPayRef]     = useState('')
  const [invoices, setInvoices] = useState([])
  const [invoiceTotal, setInvoiceTotal] = useState(0)
  const [invSkip, setInvSkip] = useState(0)
  const [invLimit, setInvLimit] = useState(DEFAULT_PAGE_SIZE)
  const [invSortBy, setInvSortBy] = useState('created_at')
  const [invSortOrder, setInvSortOrder] = useState('desc')
  const [salesSummary, setSalesSummary] = useState(null)
  const [quotations, setQuotations] = useState([])
  const [quoteTotal, setQuoteTotal] = useState(0)
  const [quoteSkip, setQuoteSkip] = useState(0)
  const [quoteLimit, setQuoteLimit] = useState(DEFAULT_PAGE_SIZE)
  const [quoteSortBy, setQuoteSortBy] = useState('created_at')
  const [quoteSortOrder, setQuoteSortOrder] = useState('desc')
  const [returns, setReturns]   = useState([])
  const [retTotal, setRetTotal] = useState(0)
  const [retSkip, setRetSkip] = useState(0)
  const [retLimit, setRetLimit] = useState(DEFAULT_PAGE_SIZE)
  const [retSortBy, setRetSortBy] = useState('date')
  const [retSortOrder, setRetSortOrder] = useState('desc')
  // Sales orders aren't implemented yet — the tab renders an empty state
  // and a "+ New Sales Order" CTA. Kept as a stable empty array for now.
  const orders = []
  const [creditPurchases, setCreditPurchases] = useState([])
  const [credTotal, setCredTotal] = useState(0)
  const [credSkip, setCredSkip] = useState(0)
  const [credLimit, setCredLimit] = useState(DEFAULT_PAGE_SIZE)
  const [credSortBy, setCredSortBy] = useState('created_at')
  const [credSortOrder, setCredSortOrder] = useState('desc')
  const [loading, setLoading]   = useState(true)
  const [branches, setBranches] = useState([])
  const [showQuoteForm, setShowQuoteForm] = useState(false)
  const [quoteForm, setQuoteForm] = useState({ customerName: '', customerId: '', branchId: 'br-001', items: [], discount: 0, validUntil: '', notes: '' })
  const pqf = (k, v) => setQuoteForm(f => ({...f, [k]: v}))
  // Only the setter is used (line ~431 — "View" button on quotes table);
  // the panel itself is wired through showDetail. Drop the getter to
  // avoid an unused-var warning.
  // eslint-disable-next-line no-unused-vars
  const [, setShowQuoteDetail] = useState(null)
  const [salesListVersion, setSalesListVersion] = useState(0)
  const [quoteListVersion, setQuoteListVersion] = useState(0)

  const loadBranches = useCallback(async () => {
    try {
      const raw = await branchesAPI.list({ skip: 0, limit: 500 }).catch(() => ({}))
      const { items } = unwrapPaged(raw)
      setBranches(items || [])
    } catch {
      setBranches([])
    }
  }, [])

  const fetchData = useCallback(async () => {
    await loadBranches()
  }, [loadBranches])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  useEffect(() => {
    setInvSkip(0)
  }, [search, statusF, branchF, dateFrom, dateTo])

  useEffect(() => {
    if (tab !== 'invoices') {
      setLoading(false)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        const raw = await salesAPI.list({
          skip: invSkip,
          limit: invLimit,
          sort_by: invSortBy,
          sort_order: invSortOrder,
          search: search || undefined,
          status: statusF || undefined,
          branch_id: branchF || undefined,
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
        })
        const { items, total, summary } = unwrapPaged(raw)
        if (!cancelled) {
          setInvoices(items || [])
          setInvoiceTotal(total)
          setSalesSummary(summary)
        }
      } catch (err) {
        console.error('Failed to fetch sales:', err)
        if (!cancelled) {
          setInvoices([])
          setInvoiceTotal(0)
          setSalesSummary(null)
        }
        toast.error('Failed to load sales data')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [tab, invSkip, invLimit, search, statusF, branchF, dateFrom, dateTo, salesListVersion, invSortBy, invSortOrder])

  useEffect(() => {
    if (tab !== 'quotes') return
    let cancelled = false
    ;(async () => {
      try {
        const raw = await salesAPI.quotations.list({
          skip: quoteSkip,
          limit: quoteLimit,
          sort_by: quoteSortBy,
          sort_order: quoteSortOrder,
        })
        const { items, total } = unwrapPaged(raw)
        if (!cancelled) {
          setQuotations(items || [])
          setQuoteTotal(total)
        }
      } catch {
        if (!cancelled) {
          setQuotations([])
          setQuoteTotal(0)
        }
      }
    })()
    return () => { cancelled = true }
  }, [tab, quoteSkip, quoteLimit, quoteListVersion, quoteSortBy, quoteSortOrder])

  useEffect(() => {
    if (tab !== 'credit') return
    let cancelled = false
    ;(async () => {
      try {
        const raw = await salesAPI.creditPurchases({
          skip: credSkip,
          limit: credLimit,
          sort_by: credSortBy,
          sort_order: credSortOrder,
        })
        const { items, total } = unwrapPaged(raw)
        if (!cancelled) {
          setCreditPurchases(items || [])
          setCredTotal(total)
        }
      } catch {
        if (!cancelled) {
          setCreditPurchases([])
          setCredTotal(0)
        }
      }
    })()
    return () => { cancelled = true }
  }, [tab, credSkip, credLimit, credSortBy, credSortOrder])

  useEffect(() => {
    if (tab !== 'returns') return
    let cancelled = false
    ;(async () => {
      try {
        const raw = await salesAPI.returns({
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
  }, [tab, retSkip, retLimit, retSortBy, retSortOrder])

  // Tab-aware sort handler for the four list tabs in this page. Each tab
  // owns its own sortBy/sortOrder pair; the closure picks them up.
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
    total:   salesSummary?.amountTotal ?? 0,
    paid:    salesSummary?.collectedPaid ?? 0,
    credit:  salesSummary?.creditPending ?? 0,
    overdue: salesSummary?.overdueTotal ?? 0,
  }), [salesSummary])

  const recordPayment = async () => {
    if (!payAmt || Number(payAmt) <= 0) { toast.error('Enter a valid amount'); return }
    try {
      await salesAPI.payment(showPayment.id, { amount: Number(payAmt), mode: payMode, ref: payRef })
      setSalesListVersion((v) => v + 1)
      await loadBranches()
      toast.success(`Payment of ${fmt(payAmt)} recorded`)
      setShowPayment(null)
      setPayAmt('')
      setPayRef('')
    } catch (err) {
      console.error('Failed to record payment:', err)
      toast.error('Failed to record payment')
    }
  }

  const saveQuotation = async () => {
    if (!quoteForm.customerName || quoteForm.items.length === 0) {
      toast.error('Enter customer and add items')
      return
    }
    // Validate all items have name and qty
    if (!quoteForm.items.every(i => i.name && Number(i.qty) > 0 && Number(i.price) > 0)) {
      toast.error('Each item must have name, qty, and price')
      return
    }
    try {
      const payload = {
        customer_name: quoteForm.customerName,
        customer_id: quoteForm.customerId || null,
        branch_id: quoteForm.branchId,
        branch_name: branches.find(b => b.id === quoteForm.branchId)?.name || '',
        created_by: 'Staff',
        valid_until: quoteForm.validUntil,
        items: quoteForm.items.map(i => ({
          item_id: i.item_id || null,
          name: i.name,
          qty: Number(i.qty),
          price: Number(i.price),
          tax_rate: Number(i.taxRate || 0),
          line_discount: Number(i.lineDiscount || 0)
        })),
        discount: Number(quoteForm.discount),
        notes: quoteForm.notes
      }
      await salesAPI.quotations.create(payload)
      setQuoteSkip(0)
      setQuoteListVersion((v) => v + 1)
      await loadBranches()
      toast.success('Quotation created successfully')
      setShowQuoteForm(false)
      setQuoteForm({ customerName: '', customerId: '', branchId: 'br-001', items: [], discount: 0, validUntil: '', notes: '' })
    } catch (err) {
      console.error('Failed to save quotation:', err)
      toast.error('Failed to create quotation')
    }
  }

  if (loading) {
    return <div className="page-container"><div style={{padding: 40, textAlign: 'center'}}>Loading sales...</div></div>
  }

  return (
    <div className="page-container">
      <SectionHeader title="Sales Management" subtitle="Invoices, orders, quotations, and customer payments">
        <button className="btn btn-secondary btn-sm" onClick={() => {
          const exportData = invoices.map(i => ({
            'Invoice Number': i.number || i.id,
            'Customer': i.customerName || 'Walk-in',
            'Date': i.date || '—',
            'Amount (₹)': i.total || 0,
            'Paid (₹)': i.paidAmount || 0,
            'Outstanding (₹)': (i.total || 0) - (i.paidAmount || 0),
            'Status': statusLabel(i.status),
          }))
          exportToCSV(exportData, `Sales_${new Date().toISOString().split('T')[0]}.csv`)
          toast.success('Sales exported')
        }}>↓ Export</button>
        {can('invoices.create') && (
          <button className="btn btn-secondary btn-sm" onClick={() => toast('Quotation feature coming soon')}>+ Quotation</button>
        )}
        {can('pos.use', 'invoices.create') && (
          <button className="btn btn-primary btn-sm" onClick={() => navigate('/pos')}>+ New Sale</button>
        )}
      </SectionHeader>

      <div className="grid-kpi" style={{ marginBottom: 20 }}>
        <KPICard label="Total Sales (Today)" value={fmt(totals.total)} color="var(--accent)" icon="💰" />
        <KPICard label="Collected"           value={fmt(totals.paid)}  color="var(--green)"  icon="✅" />
        <KPICard label="On Credit"           value={fmt(totals.credit)} color="var(--amber)" icon="📋" />
        <KPICard label="Overdue"             value={fmt(totals.overdue)} color="var(--red)"  icon="⚠️" />
      </div>

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === 'invoices' && (
        <>
          <div className="filter-bar">
            <SearchBar value={search} onChange={setSearch} placeholder="Search invoice #, customer…" />
            <select className="form-input" style={{ width: 140 }} value={statusF} onChange={(e) => setStatusF(e.target.value)}>
              <option value="">All Statuses</option>
              {['paid', 'pending', 'partial', 'overdue', 'draft'].map((s) => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
            </select>
            <select className="form-input" style={{ width: 150 }} value={branchF} onChange={(e) => setBranchF(e.target.value)}>
              <option value="">All Branches</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <input type="date" className="form-input" style={{ width: 140 }} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} placeholder="From" />
            <input type="date" className="form-input" style={{ width: 140 }} value={dateTo}   onChange={(e) => setDateTo(e.target.value)} placeholder="To" />
          </div>

          <Card bodyPadding={false}>
            {invoices.length === 0 ? <EmptyState icon="🧾" title="No invoices found" /> : (
              <table className="data-table">
                <thead>
                  <tr>
                    <SortableHeader label="Invoice #" sortKey="number" sortBy={invSortBy} sortOrder={invSortOrder} onSort={(k) => toggleSort(invSortBy, invSortOrder, setInvSortBy, setInvSortOrder, setInvSkip, k, 'desc')} />
                    <SortableHeader label="Customer" sortKey="customer_name" sortBy={invSortBy} sortOrder={invSortOrder} onSort={(k) => toggleSort(invSortBy, invSortOrder, setInvSortBy, setInvSortOrder, setInvSkip, k)} />
                    <SortableHeader label="Branch" sortKey="branch_id" sortBy={invSortBy} sortOrder={invSortOrder} onSort={(k) => toggleSort(invSortBy, invSortOrder, setInvSortBy, setInvSortOrder, setInvSkip, k)} />
                    <SortableHeader label="Date" sortKey="date" sortBy={invSortBy} sortOrder={invSortOrder} onSort={(k) => toggleSort(invSortBy, invSortOrder, setInvSortBy, setInvSortOrder, setInvSkip, k, 'desc')} />
                    <SortableHeader label="Cashier" sortKey="cashier" sortBy={invSortBy} sortOrder={invSortOrder} onSort={(k) => toggleSort(invSortBy, invSortOrder, setInvSortBy, setInvSortOrder, setInvSkip, k)} />
                    <SortableHeader label="Amount" sortKey="total" sortBy={invSortBy} sortOrder={invSortOrder} onSort={(k) => toggleSort(invSortBy, invSortOrder, setInvSortBy, setInvSortOrder, setInvSkip, k, 'desc')} className="text-right" align="right" />
                    <SortableHeader label="Paid" sortKey="paid_amount" sortBy={invSortBy} sortOrder={invSortOrder} onSort={(k) => toggleSort(invSortBy, invSortOrder, setInvSortBy, setInvSortOrder, setInvSkip, k, 'desc')} className="text-right" align="right" />
                    <SortableHeader label="Mode" sortKey="payment_mode" sortBy={invSortBy} sortOrder={invSortOrder} onSort={(k) => toggleSort(invSortBy, invSortOrder, setInvSortBy, setInvSortOrder, setInvSkip, k)} />
                    <SortableHeader label="Status" sortKey="status" sortBy={invSortBy} sortOrder={invSortOrder} onSort={(k) => toggleSort(invSortBy, invSortOrder, setInvSortBy, setInvSortOrder, setInvSkip, k)} />
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => (
                    <tr key={inv.id}>
                      <td><span className="mono" style={{ color: 'var(--accent)', fontSize: 12 }}>{inv.number}</span></td>
                      <td>
                        <div style={{ fontWeight: 500, color: 'var(--text-primary)', fontSize: 13 }}>{inv.customerName || 'Walk-in'}</div>
                        {inv.notes && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{inv.notes}</div>}
                      </td>
                      <td style={{ fontSize: 12 }}>{inv.branchName || inv.branchId || 'N/A'}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{inv.date}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{inv.cashier || 'N/A'}</td>
                      <td className="text-right mono" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{fmt(inv.total)}</td>
                      <td className="text-right mono" style={{ color: (inv.paidAmount || 0) >= inv.total ? 'var(--green)' : 'var(--amber)' }}>{fmt(inv.paidAmount || 0)}</td>
                      <td><Tag>{(inv.paymentMode || 'cash').toUpperCase()}</Tag></td>
                      <td><Chip status={inv.status} /></td>
                      <td>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button className="btn btn-ghost btn-xs" onClick={() => setShowDetail(inv)}>View</button>
                          {['pending', 'partial', 'overdue'].includes(inv.status) && can('invoices.edit') &&
                            <button className="btn btn-primary btn-xs" onClick={() => { setShowPayment(inv); setPayAmt(String((inv.total || 0) - (inv.paidAmount || 0))) }}>Pay</button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <PaginationBar
              total={invoiceTotal}
              skip={invSkip}
              limit={invLimit}
              onSkipChange={setInvSkip}
              onLimitChange={setInvLimit}
              disabled={loading}
            />
          </Card>
        </>
      )}

      {tab === 'quotes' && (
        <>
          {can('invoices.create') && (
            <div style={{display:'flex',justifyContent:'flex-end',marginBottom:14}}>
              <button className="btn btn-primary btn-sm" onClick={() => setShowQuoteForm(true)}>+ Create Quotation</button>
            </div>
          )}
          <Card bodyPadding={false}>
            {quotations.length === 0 ? (
              <EmptyState icon="📄" title="No quotations" desc="No quotations created yet" />
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <SortableHeader label="Quote #" sortKey="number" sortBy={quoteSortBy} sortOrder={quoteSortOrder} onSort={(k) => toggleSort(quoteSortBy, quoteSortOrder, setQuoteSortBy, setQuoteSortOrder, setQuoteSkip, k, 'desc')} />
                    <SortableHeader label="Customer" sortKey="customer_name" sortBy={quoteSortBy} sortOrder={quoteSortOrder} onSort={(k) => toggleSort(quoteSortBy, quoteSortOrder, setQuoteSortBy, setQuoteSortOrder, setQuoteSkip, k)} />
                    <SortableHeader label="Date" sortKey="date" sortBy={quoteSortBy} sortOrder={quoteSortOrder} onSort={(k) => toggleSort(quoteSortBy, quoteSortOrder, setQuoteSortBy, setQuoteSortOrder, setQuoteSkip, k, 'desc')} />
                    <SortableHeader label="Valid Till" sortKey="valid_until" sortBy={quoteSortBy} sortOrder={quoteSortOrder} onSort={(k) => toggleSort(quoteSortBy, quoteSortOrder, setQuoteSortBy, setQuoteSortOrder, setQuoteSkip, k, 'desc')} />
                    <SortableHeader label="Amount" sortKey="total" sortBy={quoteSortBy} sortOrder={quoteSortOrder} onSort={(k) => toggleSort(quoteSortBy, quoteSortOrder, setQuoteSortBy, setQuoteSortOrder, setQuoteSkip, k, 'desc')} className="text-right" align="right" />
                    <SortableHeader label="Status" sortKey="status" sortBy={quoteSortBy} sortOrder={quoteSortOrder} onSort={(k) => toggleSort(quoteSortBy, quoteSortOrder, setQuoteSortBy, setQuoteSortOrder, setQuoteSkip, k)} />
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {quotations.map((q) => (
                    <tr key={q.id}>
                      <td className="mono" style={{ color: 'var(--accent)', fontSize: 12 }}>{q.number}</td>
                      <td style={{ fontWeight: 500, color: 'var(--text-primary)', fontSize: 13 }}>{q.customerName || 'Walk-in'}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{q.date}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{q.validUntil || '—'}</td>
                      <td className="text-right mono">{fmt(q.total)}</td>
                      <td><Chip status={q.status === 'sent' ? 'active' : q.status === 'accepted' ? 'success' : 'draft'} label={q.status.charAt(0).toUpperCase() + q.status.slice(1)} /></td>
                      <td>
                        <div style={{ display: 'flex', gap: 4 }}>
                          <button className="btn btn-ghost btn-xs" onClick={() => setShowQuoteDetail(q)}>View</button>
                          <button className="btn btn-primary btn-xs" onClick={() => toast('Converting to invoice coming soon')}>Convert</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <PaginationBar
              total={quoteTotal}
              skip={quoteSkip}
              limit={quoteLimit}
              onSkipChange={setQuoteSkip}
              onLimitChange={setQuoteLimit}
            />
          </Card>

          <QuoteFormModal
            open={showQuoteForm}
            onClose={() => setShowQuoteForm(false)}
            onSave={saveQuotation}
            quoteForm={quoteForm}
            pqf={pqf}
            branches={branches}
          />
        </>
      )}

      {tab === 'credit' && (
        <Card bodyPadding={false}>
          {creditPurchases.length === 0 ? (
            <EmptyState icon="💳" title="No credit purchases" desc="Invoices purchased on credit will appear here" />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <SortableHeader label="Invoice #" sortKey="number" sortBy={credSortBy} sortOrder={credSortOrder} onSort={(k) => toggleSort(credSortBy, credSortOrder, setCredSortBy, setCredSortOrder, setCredSkip, k, 'desc')} />
                  <SortableHeader label="Customer" sortKey="customer_name" sortBy={credSortBy} sortOrder={credSortOrder} onSort={(k) => toggleSort(credSortBy, credSortOrder, setCredSortBy, setCredSortOrder, setCredSkip, k)} />
                  <SortableHeader label="Date" sortKey="date" sortBy={credSortBy} sortOrder={credSortOrder} onSort={(k) => toggleSort(credSortBy, credSortOrder, setCredSortBy, setCredSortOrder, setCredSkip, k, 'desc')} />
                  <SortableHeader label="Amount" sortKey="total" sortBy={credSortBy} sortOrder={credSortOrder} onSort={(k) => toggleSort(credSortBy, credSortOrder, setCredSortBy, setCredSortOrder, setCredSkip, k, 'desc')} className="text-right" align="right" />
                  <th>Due Date</th>
                  <SortableHeader label="Status" sortKey="status" sortBy={credSortBy} sortOrder={credSortOrder} onSort={(k) => toggleSort(credSortBy, credSortOrder, setCredSortBy, setCredSortOrder, setCredSkip, k)} />
                  <SortableHeader label="Balance Due" sortKey="balance_due" sortBy={credSortBy} sortOrder={credSortOrder} onSort={(k) => toggleSort(credSortBy, credSortOrder, setCredSortBy, setCredSortOrder, setCredSkip, k)} className="text-right" align="right" />
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {creditPurchases.map((inv) => (
                  <tr key={inv.id}>
                    <td className="mono" style={{ color: 'var(--accent)', fontSize: 12 }}>{inv.number}</td>
                    <td style={{ fontWeight: 500, color: 'var(--text-primary)', fontSize: 13 }}>{inv.customerName || 'Walk-in'}</td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{inv.date}</td>
                    <td className="text-right mono">{fmt(inv.total)}</td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{inv.notes || 'N/A'}</td>
                    <td><Chip status={inv.status} /></td>
                    <td className="text-right mono" style={{ color: 'var(--red)', fontWeight: 600 }}>{fmt((inv.total || 0) - (inv.paidAmount || 0))}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button className="btn btn-ghost btn-xs" onClick={() => setShowDetail(inv)}>View</button>
                        {['pending', 'partial', 'overdue'].includes(inv.status) &&
                          <button className="btn btn-primary btn-xs" onClick={() => { setShowPayment(inv); setPayAmt(String((inv.total || 0) - (inv.paidAmount || 0))) }}>Pay</button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <PaginationBar
            total={credTotal}
            skip={credSkip}
            limit={credLimit}
            onSkipChange={setCredSkip}
            onLimitChange={setCredLimit}
          />
        </Card>
      )}

      {tab === 'returns' && (
        <Card bodyPadding={false}>
          {returns.length === 0 ? (
            <EmptyState icon="↩️" title="No credit notes" desc="Credit notes / returns will appear here" />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <SortableHeader label="Credit Note #" sortKey="number" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k, 'desc')} />
                  <SortableHeader label="Customer" sortKey="customer_name" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k)} />
                  <SortableHeader label="Ref Invoice" sortKey="ref_invoice" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k)} />
                  <SortableHeader label="Date" sortKey="date" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k, 'desc')} />
                  <SortableHeader label="Amount" sortKey="amount" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k, 'desc')} className="text-right" align="right" />
                  <th>Reason</th>
                  <SortableHeader label="Status" sortKey="status" sortBy={retSortBy} sortOrder={retSortOrder} onSort={(k) => toggleSort(retSortBy, retSortOrder, setRetSortBy, setRetSortOrder, setRetSkip, k)} />
                </tr>
              </thead>
              <tbody>
                {returns.map((r) => (
                  <tr key={r.id}>
                    <td className="mono" style={{ color: 'var(--red)', fontSize: 12 }}>{r.number}</td>
                    <td style={{ fontWeight: 500, color: 'var(--text-primary)', fontSize: 13 }}>{r.customerName || r.customer_name}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{r.refInvoice || r.ref_invoice}</td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.date}</td>
                    <td className="text-right mono" style={{ color: 'var(--red)' }}>-{fmt(r.amount)}</td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{r.reason}</td>
                    <td><Chip status={r.status === 'processed' ? 'paid' : r.status} label={r.status.charAt(0).toUpperCase() + r.status.slice(1)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <PaginationBar
            total={retTotal}
            skip={retSkip}
            limit={retLimit}
            onSkipChange={setRetSkip}
            onLimitChange={setRetLimit}
          />
        </Card>
      )}

      {tab === 'orders' && (
        <Card bodyPadding={false}>
          {orders.length === 0 ? (
            <EmptyState icon="📋" title="No sales orders" desc="Sales orders will appear here once created from quotations or directly" action={<button className="btn btn-primary btn-sm" onClick={() => toast('Sales order creation coming soon')}>+ New Sales Order</button>} />
          ) : (
            <table className="data-table">
              <thead><tr><th>Order #</th><th>Customer</th><th>Date</th><th className="text-right">Amount</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td className="mono" style={{ color: 'var(--accent)', fontSize: 12 }}>{o.number}</td>
                    <td style={{ fontWeight: 500, color: 'var(--text-primary)', fontSize: 13 }}>{o.customerName || o.customer_name}</td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{o.date}</td>
                    <td className="text-right mono">{fmt(o.total)}</td>
                    <td><Chip status={o.status} /></td>
                    <td><button className="btn btn-ghost btn-xs" onClick={() => toast('Order details coming soon')}>View</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {/* Invoice Detail Modal */}
      <Modal open={!!showDetail} onClose={() => setShowDetail(null)} title={`Invoice — ${showDetail?.number}`} icon="🧾" size="lg"
        footer={<>
          <button className="btn btn-secondary" onClick={() => setShowDetail(null)}>Close</button>
          <button className="btn btn-secondary" onClick={() => { setShowReceipt(showDetail); setShowDetail(null) }}>🖨 Receipt</button>
          {['pending','partial','overdue'].includes(showDetail?.status) && <button className="btn btn-primary" onClick={() => { setShowPayment(showDetail); setShowDetail(null) }}>Record Payment</button>}
        </>}>
        {showDetail && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 18 }}>
              {[
                { label: 'Customer', value: showDetail.customerName || 'Walk-in' },
                { label: 'Branch', value: showDetail.branchName || showDetail.branchId },
                { label: 'Cashier', value: showDetail.cashier || 'N/A' },
                { label: 'Date', value: showDetail.date },
                { label: 'Payment Mode', value: (showDetail.paymentMode || 'cash').toUpperCase() },
                { label: 'Status', value: <Chip status={showDetail.status} /> },
              ].map((r) => (
                <div key={r.label} style={{ padding: '10px 12px', background: 'var(--bg-raised)', borderRadius: 8 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>{r.label}</div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{r.value}</div>
                </div>
              ))}
            </div>
            <table className="data-table" style={{ marginBottom: 14 }}>
              <thead><tr><th>Item</th><th className="text-right">Qty</th><th className="text-right">Price</th><th className="text-right">GST</th><th className="text-right">Total</th></tr></thead>
              <tbody>
                {(showDetail.items || []).map((item, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{item.name}</td>
                    <td className="text-right mono">{item.qty}</td>
                    <td className="text-right mono">{fmt(item.price)}</td>
                    <td className="text-right mono">{item.taxRate || 0}%</td>
                    <td className="text-right mono">{fmt(item.lineTotal || (item.qty * item.price))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'flex-end' }}>
              <div style={{ display: 'flex', gap: 80, fontSize: 13, color: 'var(--text-muted)' }}><span>Subtotal</span><span className="mono">{fmt(showDetail.subtotal || (showDetail.total - (showDetail.taxTotal || 0)))}</span></div>
              <div style={{ display: 'flex', gap: 80, fontSize: 13, color: 'var(--text-muted)' }}><span>GST</span><span className="mono">{fmt(showDetail.taxTotal || 0)}</span></div>
              {(showDetail.discount || 0) > 0 && <div style={{ display: 'flex', gap: 80, fontSize: 13, color: 'var(--green)' }}><span>Discount</span><span className="mono">-{fmt(showDetail.discount)}</span></div>}
              <div style={{ display: 'flex', gap: 80, fontSize: 17, fontWeight: 700 }}><span>Total</span><span className="mono" style={{ color: 'var(--accent)' }}>{fmt(showDetail.total)}</span></div>
              <div style={{ display: 'flex', gap: 80, fontSize: 13, color: 'var(--green)' }}><span>Paid</span><span className="mono">{fmt(showDetail.paidAmount || 0)}</span></div>
              {(showDetail.total || 0) > (showDetail.paidAmount || 0) && <div style={{ display: 'flex', gap: 80, fontSize: 13, color: 'var(--red)' }}><span>Balance Due</span><span className="mono">{fmt((showDetail.total || 0) - (showDetail.paidAmount || 0))}</span></div>}
            </div>
          </>
        )}
      </Modal>

      {/* Payment Modal */}
      <Modal open={!!showPayment} onClose={() => setShowPayment(null)} title="Record Payment" icon="💳" size="sm"
        footer={<>
          <button className="btn btn-secondary" onClick={() => setShowPayment(null)}>Cancel</button>
          <button className="btn btn-primary" onClick={recordPayment}>Record Payment</button>
        </>}>
        {showPayment && (
          <>
            <AlertBar type="blue" icon="ℹ">
              Balance due: <strong>{fmt((showPayment.total || 0) - (showPayment.paidAmount || 0))}</strong> for {showPayment.customerName || 'Walk-in'}
            </AlertBar>
            <div style={{ height: 14 }} />
            <FormGroup label="Amount Received (₹)" required>
              <input className="form-input" type="number" value={payAmt} onChange={(e) => setPayAmt(e.target.value)} autoFocus />
            </FormGroup>
            <FormGroup label="Payment Mode">
              <select className="form-input" value={payMode} onChange={(e) => setPayMode(e.target.value)}>
                {['cash', 'upi', 'bank_transfer', 'cheque', 'card'].map((m) => <option key={m} value={m}>{m.replace('_', ' ').toUpperCase()}</option>)}
              </select>
            </FormGroup>
            <FormGroup label="Reference / Transaction ID">
              <input className="form-input" value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="UTR / cheque number" />
            </FormGroup>
          </>
        )}
      </Modal>

      {/* Receipt Modal */}
      <Modal open={!!showReceipt} onClose={() => setShowReceipt(null)} title={`Receipt — ${showReceipt?.number}`} icon="🧾" size="md">
        {showReceipt && (
          <Receipt
            sale={showReceipt}
            branch={branches.find(b => b.id === showReceipt.branchId)}
            onClose={() => setShowReceipt(null)}
          />
        )}
      </Modal>
    </div>
  )
}
