import { useState, useEffect, useMemo, useCallback } from 'react'
import toast from 'react-hot-toast'
import { customersAPI, branchesAPI } from '@/api'
import { useAppStore } from '@/store'
import { useCan } from '@/auth/permissions'
import { fmt, exportToCSV } from '@/utils/helpers'
import { SectionHeader, Card, SearchBar, Chip, KPICard, Modal, FormGroup, FormRow, EmptyState, ProgressBar, Tag, AlertBar, PaginationBar, SortableHeader } from '@/components/ui'
import { unwrapPaged, DEFAULT_PAGE_SIZE, fetchAllList } from '@/utils/pagination'

export default function CustomersPage() {
  const can = useCan()
  const [search, setSearch]     = useState('')
  const [typeF, setTypeF]       = useState('')
  const [showAdd, setShowAdd]   = useState(false)
  const [showDetail, setShowDetail] = useState(null)
  const [ledgerCustomer, setLedgerCustomer] = useState(null)
  const [ledgerEntries, setLedgerEntries] = useState([])
  const [ledgerLoading, setLedgerLoading] = useState(false)
  const [ledgerTotal, setLedgerTotal] = useState(0)
  const [customers, setCustomers] = useState([])
  const [custTotal, setCustTotal] = useState(0)
  const [custSkip, setCustSkip] = useState(0)
  const [custLimit, setCustLimit] = useState(DEFAULT_PAGE_SIZE)
  const [custSortBy, setCustSortBy] = useState('name')
  const [custSortOrder, setCustSortOrder] = useState('asc')
  const [custSummary, setCustSummary] = useState(null)
  const branches = useAppStore((s) => s.branches)
  const [loading, setLoading]   = useState(true)
  const [listVersion, setListVersion] = useState(0)
  const [saving, setSaving] = useState(false)
  const [form, setForm]         = useState({ name:'', phone:'', email:'', address:'', gst_in:'', branch_id:'', credit_limit:'10000', customer_type:'retail' })

  const pf = (k,v) => setForm(f=>({...f,[k]:v}))

  useEffect(() => {
    if (branches.length > 0 && !form.branch_id) {
      setForm((f) => ({ ...f, branch_id: branches[0].id }))
    }
  }, [branches, form.branch_id])

  useEffect(() => {
    setCustSkip(0)
  }, [search, typeF])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        const raw = await customersAPI.list({
          skip: custSkip,
          limit: custLimit,
          sort_by: custSortBy,
          sort_order: custSortOrder,
          search: search || undefined,
          customer_type: typeF || undefined,
        })
        const { items, total, summary } = unwrapPaged(raw)
        if (cancelled) return
        const mapped = (items || []).map((c) => ({
          ...c,
          type: c.customer_type || c.type,
          gstIn: c.gst_in || c.gstin,
          branchId: c.branch_id,
          creditLimit: c.credit_limit,
          outstanding: c.outstanding || 0,
          // Sales Phase 1 (2026-05-23): money we owe the customer
          // (overpayments + return refunds-as-credit). Separate from
          // `outstanding` — both can be non-zero. Display only here;
          // applying credit to an invoice is manual in v1.
          creditBalance: c.credit_balance || 0,
          totalPurchases: c.total_purchases || 0,
        }))
        setCustomers(mapped)
        setCustTotal(total)
        setCustSummary(summary)
      } catch (err) {
        console.error('Failed to fetch data:', err)
        if (!cancelled) {
          setCustomers([])
          setCustTotal(0)
          setCustSummary(null)
        }
        toast.error('Failed to load data')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [custSkip, custLimit, search, typeF, listVersion, custSortBy, custSortOrder])

  const onSort = (key) => {
    setCustSkip(0)
    if (custSortBy === key) {
      setCustSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'))
      return
    }
    setCustSortBy(key)
    setCustSortOrder('asc')
  }

  const totals = useMemo(() => ({
    total:       custTotal,
    outstanding: custSummary?.outstandingTotal ?? 0,
    overdue:     custSummary?.withBalanceCount ?? 0,
    topBuyer:    customers.length > 0 ? customers.reduce((a, c) => (c.totalPurchases || 0) > (a.totalPurchases || 0) ? c : a, customers[0]) : null,
  }), [custTotal, custSummary, customers])

  const save = async () => {
    if (saving) return
    if (!form.name) { toast.error('Customer name required'); return }
    if (!form.branch_id) { toast.error('Select a branch'); return }

    setSaving(true)
    try {
      const payload = {
        name: form.name,
        phone: form.phone,
        email: form.email,
        address: form.address,
        gst_in: form.gst_in,
        branch_id: form.branch_id,
        credit_limit: Number(form.credit_limit) || 0,
        customer_type: form.customer_type
      }

      await customersAPI.create(payload)
      setListVersion((v) => v + 1)
      toast.success('Customer added successfully')
      setShowAdd(false)
      setForm({ name:'', phone:'', email:'', address:'', gst_in:'', branch_id: branches[0]?.id || '', credit_limit:'10000', customer_type:'retail' })
    } catch (err) {
      console.error('Failed to save customer:', err)
      toast.error('Failed to add customer')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="page-container"><div style={{padding: 40, textAlign: 'center'}}>Loading customers...</div></div>
  }

  const creditUsedPct = (c) => c.creditLimit > 0 ? Math.min(100, (c.outstanding / c.creditLimit) * 100) : 0

  const openCreditLedger = async (customer) => {
    setLedgerCustomer(customer)
    setLedgerLoading(true)
    setLedgerEntries([])
    try {
      const raw = await customersAPI.creditLedger(customer.id, { skip: 0, limit: 100 })
      const { items, total } = unwrapPaged(raw)
      setLedgerEntries(items || [])
      setLedgerTotal(total || 0)
    } catch (err) {
      console.error('Failed to load credit ledger:', err)
      toast.error('Failed to load credit ledger')
      setLedgerCustomer(null)
    } finally {
      setLedgerLoading(false)
    }
  }

  const entryTypeColor = (type) => {
    if (type?.includes('debit') || type?.includes('revoke')) return 'var(--red)'
    if (type?.includes('credit') || type?.includes('overpayment') || type?.includes('restore')) return 'var(--green)'
    return 'var(--text-primary)'
  }

  return (
    <div className="page-container">
      <SectionHeader title="Customer Master" subtitle="Manage customers, credit limits, and outstanding balances">
        <button className="btn btn-secondary btn-sm" onClick={() => {
          const exportData = customers.map(c => ({
            'Name': c.name,
            'Phone': c.phone || '—',
            'Email': c.email || '—',
            'Address': c.address || '—',
            'GST Reg No': c.gstIn || '—',
            'Type': (c.type || 'Retail').charAt(0).toUpperCase() + (c.type || 'Retail').slice(1),
            'Credit Limit (MVR)': c.creditLimit || 0,
            'Outstanding (MVR)': c.outstanding || 0,
            'Total Purchases (MVR)': c.totalPurchases || 0,
          }))
          exportToCSV(exportData, `Customers_${new Date().toISOString().split('T')[0]}.csv`)
          toast.success('Customers exported')
        }}>↓ Export</button>
        {can('customers.create') && (
          <button className="btn btn-primary btn-sm" onClick={() => setShowAdd(true)}>+ Add Customer</button>
        )}
      </SectionHeader>

      <div className="grid-kpi" style={{ marginBottom: 20 }}>
        <KPICard label="Total Customers"    value={totals.total}                    color="var(--accent)" icon="👥" />
        <KPICard label="Outstanding Total"  value={fmt(totals.outstanding)}         color="var(--red)"   icon="📋" />
        <KPICard label="With Balance Due"   value={totals.overdue}                  color="var(--amber)" icon="⚠️" />
        <KPICard label="Top Buyer"          value={totals.topBuyer?.name?.split(' ')[0] || '—'} color="var(--green)" icon="🏆" sub={totals.topBuyer ? fmt(totals.topBuyer.total_purchases || 0) : '—'} />
      </div>

      <div className="filter-bar">
        <SearchBar value={search} onChange={setSearch} placeholder="Search name, phone, email…" />
        <select className="form-input" style={{ width: 140 }} value={typeF} onChange={e => setTypeF(e.target.value)}>
          <option value="">All Types</option>
          <option value="retail">Retail</option>
          <option value="wholesale">Wholesale / B2B</option>
        </select>
      </div>

      <Card bodyPadding={false}>
        {customers.length === 0 ? <EmptyState icon="👥" title="No customers found" /> : (
          <table className="data-table">
            <thead>
              <tr>
                <SortableHeader label="Customer" sortKey="name" sortBy={custSortBy} sortOrder={custSortOrder} onSort={onSort} />
                <SortableHeader label="Contact" sortKey="phone" sortBy={custSortBy} sortOrder={custSortOrder} onSort={onSort} />
                <SortableHeader label="Type" sortKey="customer_type" sortBy={custSortBy} sortOrder={custSortOrder} onSort={onSort} />
                <th>Branch</th>
                <SortableHeader label="Credit Limit" sortKey="credit_limit" sortBy={custSortBy} sortOrder={custSortOrder} onSort={onSort} className="text-right" align="right" />
                <SortableHeader label="Outstanding" sortKey="outstanding" sortBy={custSortBy} sortOrder={custSortOrder} onSort={onSort} className="text-right" align="right" />
                {/* Sales Phase 1 (2026-05-23): money we owe the customer.
                    Read-only display; applying credit is manual in v1. Not
                    server-side sortable yet (would need backend allow-list
                    update) — defer to PR 2 if anyone asks. */}
                <th className="text-right" style={{textAlign:'right'}}>Credit</th>
                <th style={{width:100}}>Credit Used</th>
                <SortableHeader label="Total Purchases" sortKey="total_purchases" sortBy={custSortBy} sortOrder={custSortOrder} onSort={onSort} className="text-right" align="right" />
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {customers.map(c => {
                const pct = creditUsedPct(c)
                return (
                  <tr key={c.id}>
                    <td>
                      <div style={{ fontWeight:500, color:'var(--text-primary)', fontSize:13 }}>{c.name}</div>
                      <div style={{ fontSize:11, color:'var(--text-muted)' }}>{c.gstIn || 'No GST Reg No'}</div>
                    </td>
                    <td>
                      <div style={{ fontSize:12.5 }}>{c.phone}</div>
                      <div style={{ fontSize:11, color:'var(--text-muted)' }}>{c.email || '—'}</div>
                    </td>
                    <td><Tag color={c.type==='wholesale' ? 'var(--purple)' : undefined}>{c.type === 'wholesale' ? 'Wholesale' : 'Retail'}</Tag></td>
                    <td style={{ fontSize:12 }}>{branches.find(b=>b.id===c.branchId)?.name || c.branchId}</td>
                    <td className="text-right mono">{fmt(c.creditLimit)}</td>
                    <td className="text-right mono" style={{ color: c.outstanding > 0 ? 'var(--red)' : 'var(--green)' }}>{fmt(c.outstanding)}</td>
                    <td className="text-right mono" style={{ color: c.creditBalance > 0 ? 'var(--accent)' : 'var(--text-muted)' }}>
                      {c.creditBalance > 0 ? fmt(c.creditBalance) : '—'}
                    </td>
                    <td>
                      <ProgressBar value={pct} color={pct > 80 ? 'var(--red)' : pct > 50 ? 'var(--amber)' : 'var(--green)'} />
                      <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:2 }}>{Math.round(pct)}%</div>
                    </td>
                    <td className="text-right mono">{fmt(c.totalPurchases)}</td>
                    <td><Chip status={c.active ? 'active' : 'inactive'} /></td>
                    <td>
                      <div style={{ display:'flex', gap:4 }}>
                        <button className="btn btn-ghost btn-xs" onClick={() => setShowDetail(c)}>View</button>
                        {can('customers.edit') && (
                          <button className="btn btn-ghost btn-xs">Edit</button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        <PaginationBar
          total={custTotal}
          skip={custSkip}
          limit={custLimit}
          onSkipChange={setCustSkip}
          onLimitChange={setCustLimit}
          disabled={loading}
        />
      </Card>

      {/* Add Customer */}
      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Add Customer" icon="👤" size="md" busy={saving}
        footer={<><button className="btn btn-secondary" onClick={()=>setShowAdd(false)} disabled={saving}>Cancel</button><button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Customer'}</button></>}>
        <FormRow><FormGroup label="Name" required><input className="form-input" value={form.name} onChange={e=>pf('name',e.target.value)} placeholder="Full name or company" /></FormGroup>
        <FormGroup label="Phone"><input className="form-input" value={form.phone} onChange={e=>pf('phone',e.target.value)} placeholder="10-digit mobile" /></FormGroup></FormRow>
        <FormRow><FormGroup label="Email"><input className="form-input" value={form.email} onChange={e=>pf('email',e.target.value)} type="email" /></FormGroup>
        <FormGroup label="GST Reg No"><input className="form-input" value={form.gst_in} onChange={e=>pf('gst_in',e.target.value)} placeholder="For business customers" /></FormGroup></FormRow>
        <FormGroup label="Address"><textarea className="form-input" style={{height:64}} value={form.address} onChange={e=>pf('address',e.target.value)} /></FormGroup>
        <FormRow>
          <FormGroup label="Primary Branch" required><select className="form-input" value={form.branch_id} onChange={e=>pf('branch_id',e.target.value)}><option value="">Select branch…</option>{branches.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></FormGroup>
          <FormGroup label="Type"><select className="form-input" value={form.customer_type} onChange={e=>pf('customer_type',e.target.value)}><option value="retail">Retail</option><option value="wholesale">Wholesale / B2B</option></select></FormGroup>
        </FormRow>
        <FormGroup label="Credit Limit (MVR)"><input className="form-input" type="number" value={form.credit_limit} onChange={e=>pf('credit_limit',e.target.value)} /></FormGroup>
      </Modal>

      {/* Detail Modal */}
      <Modal open={!!showDetail} onClose={()=>setShowDetail(null)} title={showDetail?.name} icon="👤" size="md"
        footer={<><button className="btn btn-secondary" onClick={()=>setShowDetail(null)}>Close</button><button className="btn btn-primary" onClick={()=>{ openCreditLedger(showDetail); setShowDetail(null) }}>View Credit Ledger</button></>}>
        {showDetail && (
          <>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:16 }}>
              {[
                {label:'Phone', value:showDetail.phone},{label:'Email', value:showDetail.email||'—'},
                {label:'GST Reg No', value:showDetail.gstIn||'—'},{label:'Type', value:showDetail.type==='wholesale'?'Wholesale':'Retail'},
                {label:'Credit Limit', value:fmt(showDetail.creditLimit)},
                {label:'Outstanding', value:<span style={{color:showDetail.outstanding>0?'var(--red)':'var(--green)'}}>{fmt(showDetail.outstanding)}</span>},
                {label:'Store Credit', value:<span style={{color:showDetail.creditBalance>0?'var(--accent)':'var(--text-muted)'}}>{showDetail.creditBalance>0?fmt(showDetail.creditBalance):'—'}</span>},
                {label:'Total Purchases', value:fmt(showDetail.totalPurchases)},{label:'Status', value:<Chip status={showDetail.active?'active':'inactive'}/>},
              ].map(r=>(
                <div key={r.label} style={{padding:'10px 12px',background:'var(--bg-raised)',borderRadius:8}}>
                  <div style={{fontSize:11,color:'var(--text-muted)',marginBottom:3}}>{r.label}</div>
                  <div style={{fontSize:13,fontWeight:500,color:'var(--text-primary)'}}>{r.value}</div>
                </div>
              ))}
            </div>
            {showDetail.outstanding > 0 && (
              <AlertBar type="amber" icon="⚠️">
                Outstanding balance of <strong>{fmt(showDetail.outstanding)}</strong> — {Math.round(creditUsedPct(showDetail))}% of credit limit used.
              </AlertBar>
            )}
          </>
        )}
      </Modal>

      {/* Credit Ledger */}
      <Modal
        open={!!ledgerCustomer}
        onClose={() => setLedgerCustomer(null)}
        title={`Credit Ledger — ${ledgerCustomer?.name || ''}`}
        icon="💳"
        size="lg"
        footer={<button className="btn btn-secondary" onClick={() => setLedgerCustomer(null)}>Close</button>}
      >
        {ledgerCustomer && (
          <>
            <div style={{ display:'flex', gap:16, marginBottom:16, flexWrap:'wrap' }}>
              <div style={{ padding:'10px 14px', background:'var(--bg-raised)', borderRadius:8 }}>
                <div style={{ fontSize:11, color:'var(--text-muted)' }}>Current balance</div>
                <div style={{ fontSize:18, fontWeight:600, color:'var(--accent)' }}>{fmt(ledgerCustomer.creditBalance)}</div>
              </div>
              <div style={{ padding:'10px 14px', background:'var(--bg-raised)', borderRadius:8 }}>
                <div style={{ fontSize:11, color:'var(--text-muted)' }}>Ledger entries</div>
                <div style={{ fontSize:18, fontWeight:600 }}>{ledgerTotal}</div>
              </div>
            </div>
            {ledgerLoading ? (
              <div style={{ padding:24, textAlign:'center', color:'var(--text-muted)' }}>Loading ledger…</div>
            ) : ledgerEntries.length === 0 ? (
              <EmptyState icon="💳" title="No credit movements yet" subtitle="Overpayments and return credits will appear here." />
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Reference</th>
                    <th className="text-right" style={{textAlign:'right'}}>Change</th>
                    <th className="text-right" style={{textAlign:'right'}}>Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {ledgerEntries.map(e => (
                    <tr key={e.id}>
                      <td style={{ fontSize:12 }}>{e.date}</td>
                      <td style={{ fontSize:12 }}>{e.entryLabel || e.entryType}</td>
                      <td style={{ fontSize:12, color:'var(--text-muted)' }}>{e.sourceNumber || e.sourceType || '—'}</td>
                      <td className="text-right mono" style={{ color: entryTypeColor(e.entryType), textAlign:'right' }}>
                        {e.delta >= 0 ? '+' : ''}{fmt(e.delta)}
                      </td>
                      <td className="text-right mono" style={{ textAlign:'right' }}>{fmt(e.balanceAfter)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </Modal>
    </div>
  )
}
