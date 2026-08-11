import { useState, useEffect, useCallback, useMemo } from 'react'
import toast from 'react-hot-toast'
import { vendorsAPI } from '@/api'
import { useCan } from '@/auth/permissions'
import { fmt, exportToCSV } from '@/utils/helpers'
import { SectionHeader, Card, SearchBar, KPICard, Modal, FormGroup, FormRow, EmptyState, Tag, Chip, AlertBar, PaginationBar, SortableHeader, AutocompleteDropdown, TableLoadingPanel, PageActionsMenu, buildListPageMenuActions } from '@/components/ui'
import { VENDOR_PAYMENT_TERMS_OPTIONS } from '@/utils/dropdownOptions'
import { unwrapPaged, DEFAULT_PAGE_SIZE } from '@/utils/pagination'
import { tableRowClickProps } from '@/utils/tableRowClick'

export default function VendorsPage() {
  const can = useCan()
  const [search, setSearch]   = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [showDetail, setShowDetail] = useState(null)
  const [vendors, setVendors] = useState([])
  const [vendorTotal, setVendorTotal] = useState(0)
  const [venSkip, setVenSkip] = useState(0)
  const [venLimit, setVenLimit] = useState(DEFAULT_PAGE_SIZE)
  const [venSortBy, setVenSortBy] = useState('name')
  const [venSortOrder, setVenSortOrder] = useState('asc')
  const [venSummary, setVenSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [listVersion, setListVersion] = useState(0)
  const [editingVendor, setEditingVendor] = useState(null)
  const [ledgerVendor, setLedgerVendor] = useState(null)
  const [ledgerEntries, setLedgerEntries] = useState([])
  const [ledgerTotal, setLedgerTotal] = useState(0)
  const [ledgerLoading, setLedgerLoading] = useState(false)
  const [saving, setSaving] = useState(false)
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
      const { items, total, summary } = unwrapPaged(raw)
      const mapped = (items || []).map((v) => ({
        ...v,
        creditBalance: v.credit_balance || 0,
        totalPurchases: v.total_purchases || 0,
      }))
      setVendors(mapped)
      setVendorTotal(total)
      setVenSummary(summary)
    } catch (err) {
      console.error('Failed to fetch vendors:', err)
      setVendors([])
      setVendorTotal(0)
      setVenSummary(null)
      toast.error('Failed to load vendors')
    } finally {
      setLoading(false)
    }
    // listVersion is the manual cache-bust knob — bumping it triggers a
    // re-fetch (used by save/edit handlers below). Keep it.
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

  const totals = useMemo(() => ({
    total: vendorTotal,
    outstanding: venSummary?.outstandingTotal ?? 0,
    overdue: venSummary?.withBalanceCount ?? 0,
    topVendor: vendors.length > 0
      ? vendors.reduce((a, v) => (v.totalPurchases || 0) > (a.totalPurchases || 0) ? v : a, vendors[0])
      : null,
  }), [vendorTotal, venSummary, vendors])

  const save = async () => {
    if (saving) return
    if (!form.name) { toast.error('Vendor name required'); return }
    setSaving(true)
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
    } finally {
      setSaving(false)
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
    if (saving) return
    if (!form.name) { toast.error('Vendor name required'); return }
    setSaving(true)
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
    } finally {
      setSaving(false)
    }
  }

  const openCreditLedger = async (vendor) => {
    setLedgerVendor(vendor)
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

  if (loading) return (
    <div className="page-container">
      <TableLoadingPanel label="Loading vendors…" />
    </div>
  )

  return (
    <div className="page-container">
      <SectionHeader title="Vendor Master" subtitle="Manage suppliers, payment terms, and outstanding payables">
        {can('vendors.create') && (
          <button className="btn btn-primary btn-sm" onClick={()=>setShowAdd(true)}>+ Add Vendor</button>
        )}
        <PageActionsMenu actions={buildListPageMenuActions({
          onExport: () => {
            exportToCSV(vendors.map((v) => ({
              'Vendor Name': v.name,
              'Contact Person': v.contact_person || '—',
              Phone: v.phone || '—',
              Email: v.email || '—',
              Address: v.address || '—',
              'GST Reg No': v.gstin || '—',
              'Payment Terms': v.payment_terms || '—',
              'Total Purchases (MVR)': v.totalPurchases || 0,
              'Outstanding (MVR)': v.outstanding || 0,
            })), `Vendors_${new Date().toISOString().split('T')[0]}.csv`)
            toast.success('Vendors exported')
          },
          onRefresh: () => {
            setListVersion((v) => v + 1)
            toast.success('List refreshed')
          },
        })} />
      </SectionHeader>

      <div className="grid-kpi" style={{marginBottom:20}}>
        <KPICard label="Total Vendors"   value={totals.total}              color="var(--accent)"  icon="🏭" />
        <KPICard label="Total Payables"  value={fmt(totals.outstanding)}   color="var(--red)"     icon="💳" />
        <KPICard label="With Balance Due" value={totals.overdue}           color="var(--amber)"   icon="⚠️" />
        <KPICard label="Top Vendor"      value={totals.topVendor?.name?.split(' ')[0] || '—'} color="var(--green)" sub={totals.topVendor ? fmt(totals.topVendor.totalPurchases || 0) : '—'} icon="🏆" />
      </div>

      <div className="filter-bar">
        <SearchBar value={search} onChange={setSearch} placeholder="Search name, contact, phone, email…" />
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
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {vendors.map(v => (
                <tr key={v.id} {...tableRowClickProps(() => setShowDetail(v))}>
                  <td>
                    <div style={{fontWeight:500,color:'var(--text-primary)',fontSize:13}}>{v.name}</div>
                    <div style={{fontSize:11,color:'var(--text-muted)'}}>{v.address || '—'}</div>
                  </td>
                  <td>
                    <div style={{fontSize:12.5}}>{v.contact_person || '—'}</div>
                    <div style={{fontSize:11,color:'var(--text-muted)'}}>{v.phone || '—'}</div>
                  </td>
                  <td style={{fontSize:12,fontFamily:'DM Mono,monospace'}}>{v.gstin||'—'}</td>
                  <td><Tag>{v.payment_terms}</Tag></td>
                  <td className="text-right mono" style={{color:v.outstanding>0?'var(--red)':'var(--green)'}}>{fmt(v.outstanding)}</td>
                  <td className="text-right mono" style={{ color: v.creditBalance > 0 ? 'var(--accent)' : 'var(--text-muted)' }}>
                    {v.creditBalance > 0 ? fmt(v.creditBalance) : '—'}
                  </td>
                  <td className="text-right mono">{fmt(v.totalPurchases)}</td>
                  <td><Chip status={v.active ? 'active' : 'inactive'} /></td>
                  <td data-no-row-click>
                    <div style={{display:'flex',gap:4}}>
                      <button className="btn btn-ghost btn-xs" onClick={() => setShowDetail(v)}>View</button>
                      {can('vendors.edit') && (
                        <button className="btn btn-ghost btn-xs" onClick={() => openEdit(v)}>Edit</button>
                      )}
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

      <Modal open={showAdd} onClose={()=>setShowAdd(false)} title="Add Vendor" icon="🏭" size="md" busy={saving}
        footer={<><button className="btn btn-secondary" onClick={()=>setShowAdd(false)} disabled={saving}>Cancel</button><button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Vendor'}</button></>}>
        <FormRow><FormGroup label="Company / Vendor Name" required><input className="form-input" value={form.name} onChange={e=>pf('name',e.target.value)} /></FormGroup>
        <FormGroup label="Contact Person"><input className="form-input" value={form.contact_person} onChange={e=>pf('contact_person',e.target.value)} /></FormGroup></FormRow>
        <FormRow><FormGroup label="Phone"><input className="form-input" value={form.phone} onChange={e=>pf('phone',e.target.value)} /></FormGroup>
        <FormGroup label="Email"><input className="form-input" type="email" value={form.email} onChange={e=>pf('email',e.target.value)} /></FormGroup></FormRow>
        <FormGroup label="Address"><textarea className="form-input" style={{height:64}} value={form.address} onChange={e=>pf('address',e.target.value)} /></FormGroup>
        <FormRow><FormGroup label="GST Reg No"><input className="form-input" value={form.gstin} onChange={e=>pf('gstin',e.target.value)} placeholder="GST registration number" /></FormGroup>
        <FormGroup label="Payment Terms"><AutocompleteDropdown value={form.payment_terms} onChange={(v) => pf('payment_terms', v)} options={VENDOR_PAYMENT_TERMS_OPTIONS} isSearchFieldRequired={false} /></FormGroup></FormRow>
      </Modal>

      <Modal open={showEdit} onClose={()=>setShowEdit(false)} title="Edit Vendor" icon="✏️" size="md" busy={saving}
        footer={<><button className="btn btn-secondary" onClick={()=>setShowEdit(false)} disabled={saving}>Cancel</button><button className="btn btn-primary" onClick={saveEdit} disabled={saving}>{saving ? 'Saving…' : 'Save Changes'}</button></>}>
        <FormRow><FormGroup label="Company / Vendor Name" required><input className="form-input" value={form.name} onChange={e=>pf('name',e.target.value)} /></FormGroup>
        <FormGroup label="Contact Person"><input className="form-input" value={form.contact_person} onChange={e=>pf('contact_person',e.target.value)} /></FormGroup></FormRow>
        <FormRow><FormGroup label="Phone"><input className="form-input" value={form.phone} onChange={e=>pf('phone',e.target.value)} /></FormGroup>
        <FormGroup label="Email"><input className="form-input" type="email" value={form.email} onChange={e=>pf('email',e.target.value)} /></FormGroup></FormRow>
        <FormGroup label="Address"><textarea className="form-input" style={{height:64}} value={form.address} onChange={e=>pf('address',e.target.value)} /></FormGroup>
        <FormRow><FormGroup label="GST Reg No"><input className="form-input" value={form.gstin} onChange={e=>pf('gstin',e.target.value)} placeholder="GST registration number" /></FormGroup>
        <FormGroup label="Payment Terms"><AutocompleteDropdown value={form.payment_terms} onChange={(v) => pf('payment_terms', v)} options={VENDOR_PAYMENT_TERMS_OPTIONS} isSearchFieldRequired={false} /></FormGroup></FormRow>
      </Modal>

      <Modal open={!!showDetail} onClose={()=>setShowDetail(null)} title={showDetail?.name} icon="🏭" size="md"
        footer={<><button className="btn btn-secondary" onClick={()=>setShowDetail(null)}>Close</button><button className="btn btn-primary" onClick={()=>{ openCreditLedger(showDetail); setShowDetail(null) }}>View Credit Ledger</button></>}>
        {showDetail && (
          <>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:16 }}>
              {[
                { label:'Contact Person', value: showDetail.contact_person || '—' },
                { label:'Phone', value: showDetail.phone || '—' },
                { label:'Email', value: showDetail.email || '—' },
                { label:'GSTIN', value: showDetail.gstin || '—' },
                { label:'Payment Terms', value: showDetail.payment_terms || '—' },
                { label:'Outstanding', value: <span style={{ color: showDetail.outstanding > 0 ? 'var(--red)' : 'var(--green)' }}>{fmt(showDetail.outstanding)}</span> },
                { label:'Vendor Credit', value: <span style={{ color: showDetail.creditBalance > 0 ? 'var(--accent)' : 'var(--text-muted)' }}>{showDetail.creditBalance > 0 ? fmt(showDetail.creditBalance) : '—'}</span> },
                { label:'Total Purchases', value: fmt(showDetail.totalPurchases) },
                { label:'Status', value: <Chip status={showDetail.active ? 'active' : 'inactive'} /> },
              ].map(r => (
                <div key={r.label} style={{ padding:'10px 12px', background:'var(--bg-raised)', borderRadius:8 }}>
                  <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:3 }}>{r.label}</div>
                  <div style={{ fontSize:13, fontWeight:500, color:'var(--text-primary)' }}>{r.value}</div>
                </div>
              ))}
            </div>
            {showDetail.address && (
              <div style={{ padding:'10px 12px', background:'var(--bg-raised)', borderRadius:8, marginBottom:16 }}>
                <div style={{ fontSize:11, color:'var(--text-muted)', marginBottom:3 }}>Address</div>
                <div style={{ fontSize:13, fontWeight:500, color:'var(--text-primary)' }}>{showDetail.address}</div>
              </div>
            )}
            {showDetail.outstanding > 0 && (
              <AlertBar type="amber" icon="⚠️">
                Outstanding payable of <strong>{fmt(showDetail.outstanding)}</strong>.
              </AlertBar>
            )}
          </>
        )}
      </Modal>

      <Modal
        open={!!ledgerVendor}
        onClose={() => setLedgerVendor(null)}
        title={`Credit Ledger — ${ledgerVendor?.name || ''}`}
        icon="💳"
        size="lg"
        footer={<button className="btn btn-secondary" onClick={() => setLedgerVendor(null)}>Close</button>}
      >
        {ledgerVendor && (
          <>
            <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
              <div style={{ padding: '10px 14px', background: 'var(--bg-raised)', borderRadius: 8 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Current balance</div>
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
