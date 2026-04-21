import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { salesAPI, customersAPI, branchesAPI } from '@/api'
import { fmt, fmtDate, statusChip, statusLabel, exportToCSV } from '@/utils/helpers'
import { SectionHeader, Card, Tabs, SearchBar, Chip, KPICard, Modal, FormGroup, FormRow, EmptyState, Tag, AlertBar } from '@/components/ui'
import { Receipt } from '@/components/Receipt'

const TABS = [
  { id: 'invoices',  label: 'Invoices' },
  { id: 'orders',    label: 'Sales Orders' },
  { id: 'quotes',    label: 'Quotations' },
  { id: 'credit',    label: 'Credit Purchases' },
  { id: 'returns',   label: 'Credit Notes / Returns' },
]

export default function SalesPage() {
  const navigate = useNavigate()
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
  const [quotations, setQuotations] = useState([])
  const [returns, setReturns]   = useState([])
  const [orders, setOrders]     = useState([])
  const [creditPurchases, setCreditPurchases] = useState([])
  const [loading, setLoading]   = useState(true)
  const [branches, setBranches] = useState([])
  const [showQuoteForm, setShowQuoteForm] = useState(false)
  const [quoteForm, setQuoteForm] = useState({ customerName: '', customerId: '', branchId: 'br-001', items: [], discount: 0, validUntil: '', notes: '' })
  const pqf = (k, v) => setQuoteForm(f => ({...f, [k]: v}))
  const [quoteItems, setQuoteItems] = useState([])
  const [showQuoteDetail, setShowQuoteDetail] = useState(null)

  // Fetch data on mount
  useEffect(() => {
    fetchData()
  }, [])

  const fetchData = async () => {
    try {
      setLoading(true)
      const [salesData, branchesData, returnsData, creditData] = await Promise.all([
        salesAPI.list().catch(() => []),
        branchesAPI.list().catch(() => []),
        salesAPI.returns().catch(() => []),
        salesAPI.creditPurchases().catch(() => [])
      ])
      setInvoices(salesData || [])
      setBranches(branchesData || [])
      setReturns(returnsData || [])
      setCreditPurchases(creditData || [])
      // TODO: Re-enable after backend server is restarted to create quotation tables
      setQuotations([])
      setOrders([])
      
      // Fetch quotations once backend is ready
      try {
        const quoteData = await salesAPI.quotations.list()
        setQuotations(quoteData || [])
      } catch (err) {
        // Silently fail - quotation tables may not exist yet
        console.log('Quotations not available yet')
      }
    } catch (err) {
      console.error('Failed to fetch sales:', err)
      setInvoices([])
      toast.error('Failed to load sales data')
    } finally {
      setLoading(false)
    }
  }

  // Filter invoices with date range
  const filtered = useMemo(() => {
    let list = [...invoices]
    if (search)   list = list.filter((i) => i.number.toLowerCase().includes(search.toLowerCase()) || i.customerName.toLowerCase().includes(search.toLowerCase()))
    if (statusF)  list = list.filter((i) => i.status === statusF)
    if (branchF)  list = list.filter((i) => i.branchId === branchF)
    if (dateFrom) list = list.filter((i) => i.date >= dateFrom)
    if (dateTo)   list = list.filter((i) => i.date <= dateTo)
    return list
  }, [invoices, search, statusF, branchF, dateFrom, dateTo])

  const totals = useMemo(() => ({
    total:    filtered.reduce((s, i) => s + (i.total || 0), 0),
    paid:     filtered.filter((i) => i.status === 'paid').reduce((s, i) => s + (i.total || 0), 0),
    credit:   filtered.filter((i) => i.status === 'pending').reduce((s, i) => s + ((i.total || 0) - (i.paidAmount || 0)), 0),
    overdue:  filtered.filter((i) => i.status === 'overdue').reduce((s, i) => s + (i.total || 0), 0),
  }), [filtered])

  const recordPayment = async () => {
    if (!payAmt || Number(payAmt) <= 0) { toast.error('Enter a valid amount'); return }
    try {
      await salesAPI.payment(showPayment.id, { amount: Number(payAmt), mode: payMode, ref: payRef })
      await fetchData()
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
      await fetchData()
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
          const exportData = filtered.map(i => ({
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
        <button className="btn btn-secondary btn-sm" onClick={() => toast('Quotation feature coming soon')}>+ Quotation</button>
        <button className="btn btn-primary btn-sm" onClick={() => navigate('/pos')}>+ New Sale</button>
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
            {filtered.length === 0 ? <EmptyState icon="🧾" title="No invoices found" /> : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Invoice #</th><th>Customer</th><th>Branch</th><th>Date</th>
                    <th>Cashier</th><th className="text-right">Amount</th>
                    <th className="text-right">Paid</th><th>Mode</th><th>Status</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((inv) => (
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
                          {['pending', 'partial', 'overdue'].includes(inv.status) &&
                            <button className="btn btn-primary btn-xs" onClick={() => { setShowPayment(inv); setPayAmt(String((inv.total || 0) - (inv.paidAmount || 0))) }}>Pay</button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}

      {tab === 'quotes' && (
        <>
          <div style={{display:'flex',justifyContent:'flex-end',marginBottom:14}}>
            <button className="btn btn-primary btn-sm" onClick={() => setShowQuoteForm(true)}>+ Create Quotation</button>
          </div>
          <Card bodyPadding={false}>
            {quotations.length === 0 ? (
              <EmptyState icon="📄" title="No quotations" desc="No quotations created yet" />
            ) : (
              <table className="data-table">
                <thead><tr><th>Quote #</th><th>Customer</th><th>Date</th><th>Valid Till</th><th className="text-right">Amount</th><th>Status</th><th></th></tr></thead>
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
          </Card>
          
          <Modal open={showQuoteForm} onClose={() => setShowQuoteForm(false)} title="Create Quotation" size="lg"
            footer={<><button className="btn btn-secondary" onClick={() => setShowQuoteForm(false)}>Cancel</button><button className="btn btn-primary" onClick={saveQuotation}>Create</button></>}>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,marginBottom:16}}>
              <FormGroup label="Customer Name" required><input className="form-input" value={quoteForm.customerName} onChange={e => pqf('customerName', e.target.value)}/></FormGroup>
              <FormGroup label="Branch"><select className="form-input" value={quoteForm.branchId} onChange={e => pqf('branchId', e.target.value)}>{branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></FormGroup>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,marginBottom:16}}>
              <FormGroup label="Valid Until"><input className="form-input" type="date" value={quoteForm.validUntil} onChange={e => pqf('validUntil', e.target.value)}/></FormGroup>
              <FormGroup label="Discount"><input className="form-input" type="number" value={quoteForm.discount} onChange={e => pqf('discount', Number(e.target.value))}/></FormGroup>
            </div>
            <FormGroup label="Items" required>
              <table className="data-table" style={{marginBottom:12}}>
                <thead><tr><th>Item</th><th style={{width:80}}>Qty</th><th style={{width:100}}>Price</th><th style={{width:80}}>Tax %</th><th></th></tr></thead>
                <tbody>
                  {quoteForm.items.map((it, i) => (
                    <tr key={i}>
                      <td><input className="form-input" placeholder="Item name" value={it.name} onChange={e => {const n = [...quoteForm.items]; n[i].name = e.target.value; pqf('items', n)}}/></td>
                      <td><input className="form-input" type="number" value={it.qty} onChange={e => {const n = [...quoteForm.items]; n[i].qty = e.target.value; pqf('items', n)}}/></td>
                      <td><input className="form-input" type="number" value={it.price} onChange={e => {const n = [...quoteForm.items]; n[i].price = e.target.value; pqf('items', n)}}/></td>
                      <td><input className="form-input" type="number" value={it.taxRate} onChange={e => {const n = [...quoteForm.items]; n[i].taxRate = e.target.value; pqf('items', n)}}/></td>
                      <td><button className="btn btn-danger btn-xs" onClick={() => pqf('items', quoteForm.items.filter((_, j) => j !== i))}>Remove</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button className="btn btn-secondary btn-sm" onClick={() => pqf('items', [...quoteForm.items, { name: '', qty: 1, price: 0, taxRate: 0 }])}>+ Add Item</button>
            </FormGroup>
            <FormGroup label="Notes"><textarea className="form-input" style={{height:72}} value={quoteForm.notes} onChange={e => pqf('notes', e.target.value)}/></FormGroup>
          </Modal>
        </>
      )}

      {tab === 'credit' && (
        <Card bodyPadding={false}>
          {creditPurchases.length === 0 ? (
            <EmptyState icon="💳" title="No credit purchases" desc="Invoices purchased on credit will appear here" />
          ) : (
            <table className="data-table">
              <thead><tr><th>Invoice #</th><th>Customer</th><th>Date</th><th className="text-right">Amount</th><th>Due Date</th><th>Status</th><th className="text-right">Balance Due</th><th></th></tr></thead>
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
        </Card>
      )}

      {tab === 'returns' && (
        <Card bodyPadding={false}>
          {returns.length === 0 ? (
            <EmptyState icon="↩️" title="No credit notes" desc="Credit notes / returns will appear here" />
          ) : (
            <table className="data-table">
              <thead><tr><th>Credit Note #</th><th>Customer</th><th>Ref Invoice</th><th>Date</th><th className="text-right">Amount</th><th>Reason</th><th>Status</th></tr></thead>
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
