import { useState, useEffect, useCallback } from 'react'
import toast from 'react-hot-toast'
import { vendorsAPI, purchasesAPI } from '@/api'
import { useCan } from '@/auth/permissions'
import { fmt, exportToCSV } from '@/utils/helpers'
import { SectionHeader, Card, SearchBar, KPICard, Modal, FormGroup, FormRow, EmptyState, Tag, PaginationBar, SortableHeader } from '@/components/ui'
import { unwrapPaged, DEFAULT_PAGE_SIZE } from '@/utils/pagination'

export default function VendorsPage() {
  const can = useCan()
  const [search, setSearch]   = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [vendors, setVendors] = useState([])
  const [vendorTotal, setVendorTotal] = useState(0)
  const [venSkip, setVenSkip] = useState(0)
  const [venLimit, setVenLimit] = useState(DEFAULT_PAGE_SIZE)
  const [venSortBy, setVenSortBy] = useState('name')
  const [venSortOrder, setVenSortOrder] = useState('asc')
  const [loading, setLoading] = useState(true)
  const [listVersion, setListVersion] = useState(0)
  const [editingVendor, setEditingVendor] = useState(null)
  const [historyVendor, setHistoryVendor] = useState(null)
  const [historyData, setHistoryData] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [ledgerVendor, setLedgerVendor] = useState(null)
  const [ledgerEntries, setLedgerEntries] = useState([])
  const [ledgerTotal, setLedgerTotal] = useState(0)
  const [ledgerLoading, setLedgerLoading] = useState(false)
  const [form, setForm]       = useState({ name:'', contact_person:'', phone:'', email:'', address:'', gstin:'', payment_terms:'30 days' })
  const pf = (k,v) => setForm(f=>({...f,[k]:v}))

  const fetchVendors = useCallback(async () => {
    try {
      setLoading(true)
      const raw = await vendorsAPI.list({
        skip: venSkip,
        limit: venLimit,
        sort_by: venSortBy,
        sort_order: venSortOrder,
        search: search || undefined,
      })
      const { items, total } = unwrapPaged(raw)
      setVendors(items || [])
      setVendorTotal(total)
    } catch (err) {
      console.error('Failed to fetch vendors:', err)
      setVendors([])
      setVendorTotal(0)
    } finally {
      setLoading(false)
    }
    // listVersion is the manual cache-bust knob — bumping it triggers a
    // re-fetch (used by save/edit/delete handlers below). Keep it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venSkip, venLimit, search, listVersion, venSortBy, venSortOrder])

  const onSort = (key) => {
    setVenSkip(0)
    if (venSortBy === key) {
      setVenSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'))
      return
    }
    setVenSortBy(key)
    setVenSortOrder('asc')
  }

  useEffect(() => {
    fetchVendors()
  }, [fetchVendors])

  useEffect(() => {
    setVenSkip(0)
  }, [search])

  const save = async () => {
    if (!form.name) { toast.error('Vendor name required'); return }
    try {
      await vendorsAPI.create({
        name: form.name,
        contact_person: form.contact_person,
        phone: form.phone,
        email: form.email,
        address: form.address,
        gstin: form.gstin,
        payment_terms: form.payment_terms,
      })
      setListVersion((v) => v + 1)
      toast.success('Vendor added')
      setShowAdd(false)
      setForm({ name:'', contact_person:'', phone:'', email:'', address:'', gstin:'', payment_terms:'30 days' })
    } catch (err) {
      console.error('Failed to save vendor:', err)
      toast.error('Failed to save vendor')
    }
  }

  const openEdit = (vendor) => {
    setEditingVendor(vendor)
    setForm({
      name: vendor.name,
      contact_person: vendor.contact_person,
      phone: vendor.phone,
      email: vendor.email,
      address: vendor.address,
      gstin: vendor.gstin,
      payment_terms: vendor.payment_terms,
    })
    setShowEdit(true)
  }

  const saveEdit = async () => {
    if (!form.name) { toast.error('Vendor name required'); return }
    try {
      await vendorsAPI.update(editingVendor.id, {
        name: form.name,
        contact_person: form.contact_person,
        phone: form.phone,
        email: form.email,
        address: form.address,
        gstin: form.gstin,
        payment_terms: form.payment_terms,
      })
      setListVersion((v) => v + 1)
      toast.success('Vendor updated')
      setShowEdit(false)
      setEditingVendor(null)
      setForm({ name:'', contact_person:'', phone:'', email:'', address:'', gstin:'', payment_terms:'30 days' })
    } catch (err) {
      console.error('Failed to update vendor:', err)
      toast.error('Failed to update vendor')
    }
  }

  const openHistory = async (vendor) => {
    setHistoryVendor(vendor)
    setShowHistory(true)
    setHistoryLoading(true)
    try {
      const raw = await purchasesAPI.list({ vendor_id: vendor.id, skip: 0, limit: 500 })
      const { items } = unwrapPaged(raw)
      setHistoryData(items || [])
    } catch (err) {
      console.error('Failed to fetch purchase history:', err)
      setHistoryData([])
      toast.error('Failed to load purchase history')
    } finally {
      setHistoryLoading(false)
    }
  }

  const openCreditLedger = async (vendor) => {
    setLedgerVendor({
      ...vendor,
      creditBalance: vendor.credit_balance || 0,
    })
    setLedgerLoading(true)
    setLedgerEntries([])
    try {
      const raw = await vendorsAPI.creditLedger(vendor.id, { skip: 0, limit: 100 })
      const { items, total } = unwrapPaged(raw)
      setLedgerEntries(items || [])
      setLedgerTotal(total || 0)
    } catch (err) {
      console.error('Failed to load vendor credit ledger:', err)
      toast.error('Failed to load credit ledger')
      setLedgerVendor(null)
    } finally {
      setLedgerLoading(false)
    }
  }

  const entryTypeColor = (type) => {
    if (type?.includes('debit') || type?.includes('revoke')) return 'var(--red)'
    if (type?.includes('credit') || type?.includes('overpayment') || type?.includes('restore')) return 'var(--green)'
    return 'var(--text-primary)'
  }

  const totals = {
    total: vendorTotal,
    outstanding: vendors.reduce((s,v)=>s+v.outstanding,0),
    topVendor: vendors.length > 0 ? vendors.reduce((a,v)=>v.total_purchases>a.total_purchases?v:a, vendors[0]) : null,
  }

  if (loading) return <div className="page-container"><div style={{padding: 40, textAlign: 'center'}}>Loading vendors...</div></div>

  return (
    <div className="page-container">
      <SectionHeader title="Vendor Master" subtitle="Manage suppliers, payment terms, and outstanding payables">
        <button className="btn btn-secondary btn-sm" onClick={() => {
          const exportData = vendors.map(v => ({
            'Vendor Name': v.name,
            'Contact Person': v.contact_person || '—',
            'Phone': v.phone || '—',
            'Email': v.email || '—',
            'Address': v.address || '—',
            'GST Reg No': v.gstin || '—',
            'Payment Terms': v.payment_terms || '—',
            'Total Purchases (Rf)': v.total_purchases || 0,
            'Outstanding (Rf)': v.outstanding || 0,
          }))
          exportToCSV(exportData, `Vendors_${new Date().toISOString().split('T')[0]}.csv`)
          toast.success('Vendors exported')
        }}>↓ Export</button>
        {can('vendors.create') && (
          <button className="btn btn-primary btn-sm" onClick={()=>setShowAdd(true)}>+ Add Vendor</button>
        )}
      </SectionHeader>

      <div className="grid-kpi" style={{marginBottom:20}}>
        <KPICard label="Total Vendors"   value={totals.total}              color="var(--accent)"  icon="🏭" />
        <KPICard label="Total Payables"  value={fmt(totals.outstanding)}   color="var(--red)"     icon="💳" />
        <KPICard label="Top Vendor"      value={totals.topVendor?.name.split(' ')[0]} color="var(--green)" sub={fmt(totals.topVendor?.total_purchases)} icon="🏆" />
        <KPICard label="With Balance"    value={vendors.filter(v=>v.outstanding>0).length} color="var(--amber)" icon="⚠️" sub="this page" />
      </div>

      <div className="filter-bar">
        <SearchBar value={search} onChange={setSearch} placeholder="Search vendor name, contact, phone…" />
      </div>

      <Card bodyPadding={false}>
        {vendors.length === 0 ? <EmptyState icon="🏭" title="No vendors found" /> : (
          <table className="data-table">
            <thead>
              <tr>
                <SortableHeader label="Vendor" sortKey="name" sortBy={venSortBy} sortOrder={venSortOrder} onSort={onSort} />
                <SortableHeader label="Contact" sortKey="contact_person" sortBy={venSortBy} sortOrder={venSortOrder} onSort={onSort} />
                <th>GST Reg No</th>
                <SortableHeader label="Payment Terms" sortKey="payment_terms" sortBy={venSortBy} sortOrder={venSortOrder} onSort={onSort} />
                <SortableHeader label="Outstanding" sortKey="outstanding" sortBy={venSortBy} sortOrder={venSortOrder} onSort={onSort} className="text-right" align="right" />
                <th className="text-right" style={{ textAlign: 'right' }}>Credit</th>
                <SortableHeader label="Total Purchases" sortKey="total_purchases" sortBy={venSortBy} sortOrder={venSortOrder} onSort={onSort} className="text-right" align="right" />
                <th></th>
              </tr>
            </thead>
            <tbody>
              {vendors.map(v => (
                <tr key={v.id}>
                  <td>
                    <div style={{fontWeight:500,color:'var(--text-primary)',fontSize:13}}>{v.name}</div>
                    <div style={{fontSize:11,color:'var(--text-muted)'}}>{v.address}</div>
                  </td>
                  <td>
                    <div style={{fontSize:12.5}}>{v.contact_person}</div>
                    <div style={{fontSize:11,color:'var(--text-muted)'}}>{v.phone}</div>
                  </td>
                  <td style={{fontSize:12,fontFamily:'DM Mono,monospace'}}>{v.gstin||'—'}</td>
                  <td><Tag>{v.payment_terms}</Tag></td>
                  <td className="text-right mono" style={{color:v.outstanding>0?'var(--red)':'var(--green)'}}>{fmt(v.outstanding)}</td>
                  <td className="text-right mono" style={{ color: (v.credit_balance || 0) > 0 ? 'var(--accent)' : 'var(--text-muted)' }}>
                    {fmt(v.credit_balance || 0)}
                  </td>
                  <td className="text-right mono">{fmt(v.total_purchases)}</td>
                  <td>
                    <div style={{display:'flex',gap:4}}>
                      {can('vendors.edit') && (
                        <button className="btn btn-ghost btn-xs" onClick={() => openEdit(v)}>Edit</button>
                      )}
                      {(v.credit_balance || 0) > 0 && (
                        <button className="btn btn-ghost btn-xs" onClick={() => openCreditLedger(v)}>Credit</button>
                      )}
                      <button className="btn btn-primary btn-xs" onClick={() => openHistory(v)}>History</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <PaginationBar
          total={vendorTotal}
          skip={venSkip}
          limit={venLimit}
          onSkipChange={setVenSkip}
          onLimitChange={setVenLimit}
          disabled={loading}
        />
      </Card>

      <Modal open={showAdd} onClose={()=>setShowAdd(false)} title="Add Vendor" icon="🏭" size="md"
        footer={<><button className="btn btn-secondary" onClick={()=>setShowAdd(false)}>Cancel</button><button className="btn btn-primary" onClick={save}>Save Vendor</button></>}>
        <FormRow><FormGroup label="Company / Vendor Name" required><input className="form-input" value={form.name} onChange={e=>pf('name',e.target.value)} /></FormGroup>
        <FormGroup label="Contact Person"><input className="form-input" value={form.contact_person} onChange={e=>pf('contact_person',e.target.value)} /></FormGroup></FormRow>
        <FormRow><FormGroup label="Phone"><input className="form-input" value={form.phone} onChange={e=>pf('phone',e.target.value)} /></FormGroup>
        <FormGroup label="Email"><input className="form-input" type="email" value={form.email} onChange={e=>pf('email',e.target.value)} /></FormGroup></FormRow>
        <FormGroup label="Address"><textarea className="form-input" style={{height:64}} value={form.address} onChange={e=>pf('address',e.target.value)} /></FormGroup>
        <FormRow><FormGroup label="GST Reg No"><input className="form-input" value={form.gstin} onChange={e=>pf('gstin',e.target.value)} placeholder="GST registration number" /></FormGroup>
        <FormGroup label="Payment Terms"><select className="form-input" value={form.payment_terms} onChange={e=>pf('payment_terms',e.target.value)}>{['Advance','COD','7 days','15 days','30 days','45 days','60 days','Weekly'].map(t=><option key={t}>{t}</option>)}</select></FormGroup></FormRow>
      </Modal>

      <Modal open={showEdit} onClose={()=>setShowEdit(false)} title="Edit Vendor" icon="✏️" size="md"
        footer={<><button className="btn btn-secondary" onClick={()=>setShowEdit(false)}>Cancel</button><button className="btn btn-primary" onClick={saveEdit}>Save Changes</button></>}>
        <FormRow><FormGroup label="Company / Vendor Name" required><input className="form-input" value={form.name} onChange={e=>pf('name',e.target.value)} /></FormGroup>
        <FormGroup label="Contact Person"><input className="form-input" value={form.contact_person} onChange={e=>pf('contact_person',e.target.value)} /></FormGroup></FormRow>
        <FormRow><FormGroup label="Phone"><input className="form-input" value={form.phone} onChange={e=>pf('phone',e.target.value)} /></FormGroup>
        <FormGroup label="Email"><input className="form-input" type="email" value={form.email} onChange={e=>pf('email',e.target.value)} /></FormGroup></FormRow>
        <FormGroup label="Address"><textarea className="form-input" style={{height:64}} value={form.address} onChange={e=>pf('address',e.target.value)} /></FormGroup>
        <FormRow><FormGroup label="GST Reg No"><input className="form-input" value={form.gstin} onChange={e=>pf('gstin',e.target.value)} placeholder="GST registration number" /></FormGroup>
        <FormGroup label="Payment Terms"><select className="form-input" value={form.payment_terms} onChange={e=>pf('payment_terms',e.target.value)}>{['Advance','COD','7 days','15 days','30 days','45 days','60 days','Weekly'].map(t=><option key={t}>{t}</option>)}</select></FormGroup></FormRow>
      </Modal>

      <Modal open={showHistory} onClose={()=>setShowHistory(false)} title={`Purchase History - ${historyVendor?.name}`} icon="📋" size="lg">
        {historyLoading ? (
          <div style={{padding: 20, textAlign: 'center'}}>Loading purchase history...</div>
        ) : historyData.length === 0 ? (
          <EmptyState icon="📋" title="No purchase history found" />
        ) : (
          <div style={{overflowX: 'auto'}}>
            <table className="data-table" style={{minWidth: '100%'}}>
              <thead>
                <tr>
                  <th>Bill #</th>
                  <th>Date</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th className="text-right">Paid</th>
                  <th className="text-right">Pending</th>
                </tr>
              </thead>
              <tbody>
                {historyData.map(bill => (
                  <tr key={bill.id}>
                    <td style={{fontFamily:'DM Mono,monospace'}}>{bill.bill_number || bill.number || bill.id?.slice(0, 8)}</td>
                    <td>{new Date(bill.created_at).toLocaleDateString()}</td>
                    <td>{fmt(bill.total_amount || bill.amount || 0)}</td>
                    <td><Tag>{bill.status || 'pending'}</Tag></td>
                    <td className="text-right mono">{fmt(bill.paid_amount || 0)}</td>
                    <td className="text-right mono">{fmt((bill.total_amount || bill.amount || 0) - (bill.paid_amount || 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>

      <Modal
        open={!!ledgerVendor}
        onClose={() => setLedgerVendor(null)}
        title={`Vendor Credit — ${ledgerVendor?.name || ''}`}
        icon="💳"
        size="lg"
        footer={<button className="btn btn-secondary" onClick={() => setLedgerVendor(null)}>Close</button>}
      >
        {ledgerVendor && (
          <>
            <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
              <div style={{ padding: '10px 14px', background: 'var(--bg-raised)', borderRadius: 8 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Current advance</div>
                <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--accent)' }}>{fmt(ledgerVendor.creditBalance)}</div>
              </div>
              <div style={{ padding: '10px 14px', background: 'var(--bg-raised)', borderRadius: 8 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Ledger entries</div>
                <div style={{ fontSize: 18, fontWeight: 600 }}>{ledgerTotal}</div>
              </div>
            </div>
            {ledgerLoading ? (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>Loading ledger…</div>
            ) : ledgerEntries.length === 0 ? (
              <EmptyState icon="💳" title="No credit movements yet" subtitle="Overpayments will appear here." />
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Reference</th>
                    <th className="text-right" style={{ textAlign: 'right' }}>Change</th>
                    <th className="text-right" style={{ textAlign: 'right' }}>Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {ledgerEntries.map((e) => (
                    <tr key={e.id}>
                      <td style={{ fontSize: 12 }}>{e.date}</td>
                      <td style={{ fontSize: 12 }}>{e.entryLabel || e.entryType}</td>
                      <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{e.sourceNumber || e.sourceType || '—'}</td>
                      <td className="text-right mono" style={{ color: entryTypeColor(e.entryType), textAlign: 'right' }}>
                        {e.delta >= 0 ? '+' : ''}{fmt(e.delta)}
                      </td>
                      <td className="text-right mono" style={{ textAlign: 'right' }}>{fmt(e.balanceAfter)}</td>
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
