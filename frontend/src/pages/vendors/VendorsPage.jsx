import { useState, useEffect, useMemo } from 'react'
import toast from 'react-hot-toast'
import { vendorsAPI, purchasesAPI } from '@/api'
import { fmt, exportToCSV } from '@/utils/helpers'
import { SectionHeader, Card, SearchBar, Chip, KPICard, Modal, FormGroup, FormRow, EmptyState, Tag } from '@/components/ui'

export default function VendorsPage() {
  const [search, setSearch]   = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [vendors, setVendors] = useState([])
  const [loading, setLoading] = useState(true)
  const [editingVendor, setEditingVendor] = useState(null)
  const [historyVendor, setHistoryVendor] = useState(null)
  const [historyData, setHistoryData] = useState([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [form, setForm]       = useState({ name:'', contact_person:'', phone:'', email:'', address:'', gstin:'', payment_terms:'30 days' })
  const pf = (k,v) => setForm(f=>({...f,[k]:v}))

  // Fetch vendors on mount
  useEffect(() => {
    fetchVendors()
  }, [])

  const fetchVendors = async () => {
    try {
      setLoading(true)
      const data = await vendorsAPI.list()
      setVendors(data || [])
    } catch (err) {
      console.error('Failed to fetch vendors:', err)
      setVendors([])
    } finally {
      setLoading(false)
    }
  }

  const filtered = useMemo(() => {
    if (!search) return vendors
    const q = search.toLowerCase()
    return vendors.filter(v => 
      v.name.toLowerCase().includes(q) || 
      (v.contact_person && v.contact_person.toLowerCase().includes(q)) || 
      (v.phone && v.phone.includes(q))
    )
  }, [vendors, search])

  const save = async () => {
    if (!form.name) { toast.error('Vendor name required'); return }
    try {
      const data = await vendorsAPI.create({
        name: form.name,
        contact_person: form.contact_person,
        phone: form.phone,
        email: form.email,
        address: form.address,
        gstin: form.gstin,
        payment_terms: form.payment_terms,
      })
      setVendors(list => [...list, data])
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
      const data = await vendorsAPI.update(editingVendor.id, {
        name: form.name,
        contact_person: form.contact_person,
        phone: form.phone,
        email: form.email,
        address: form.address,
        gstin: form.gstin,
        payment_terms: form.payment_terms,
      })
      setVendors(list => list.map(v => v.id === editingVendor.id ? data : v))
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
      const data = await purchasesAPI.list({ vendor_id: vendor.id })
      setHistoryData(data || [])
    } catch (err) {
      console.error('Failed to fetch purchase history:', err)
      setHistoryData([])
      toast.error('Failed to load purchase history')
    } finally {
      setHistoryLoading(false)
    }
  }

  const totals = {
    total: vendors.length,
    outstanding: vendors.reduce((s,v)=>s+v.outstanding,0),
    topVendor: vendors.length > 0 ? vendors.reduce((a,v)=>v.total_purchases>a.total_purchases?v:a, vendors[0]) : null,
  }

  if (loading) return <div className="page-container"><div style={{padding: 40, textAlign: 'center'}}>Loading vendors...</div></div>

  return (
    <div className="page-container">
      <SectionHeader title="Vendor Master" subtitle="Manage suppliers, payment terms, and outstanding payables">
        <button className="btn btn-secondary btn-sm" onClick={() => {
          const exportData = filtered.map(v => ({
            'Vendor Name': v.name,
            'Contact Person': v.contact_person || '—',
            'Phone': v.phone || '—',
            'Email': v.email || '—',
            'Address': v.address || '—',
            'GSTIN': v.gstin || '—',
            'Payment Terms': v.payment_terms || '—',
            'Total Purchases (₹)': v.total_purchases || 0,
            'Outstanding (₹)': v.outstanding || 0,
          }))
          exportToCSV(exportData, `Vendors_${new Date().toISOString().split('T')[0]}.csv`)
          toast.success('Vendors exported')
        }}>↓ Export</button>
        <button className="btn btn-primary btn-sm" onClick={()=>setShowAdd(true)}>+ Add Vendor</button>
      </SectionHeader>

      <div className="grid-kpi" style={{marginBottom:20}}>
        <KPICard label="Total Vendors"   value={totals.total}              color="var(--accent)"  icon="🏭" />
        <KPICard label="Total Payables"  value={fmt(totals.outstanding)}   color="var(--red)"     icon="💳" />
        <KPICard label="Top Vendor"      value={totals.topVendor?.name.split(' ')[0]} color="var(--green)" sub={fmt(totals.topVendor?.total_purchases)} icon="🏆" />
        <KPICard label="With Balance"    value={vendors.filter(v=>v.outstanding>0).length} color="var(--amber)" icon="⚠️" />
      </div>

      <div className="filter-bar">
        <SearchBar value={search} onChange={setSearch} placeholder="Search vendor name, contact, phone…" />
      </div>

      <Card bodyPadding={false}>
        {filtered.length === 0 ? <EmptyState icon="🏭" title="No vendors found" /> : (
          <table className="data-table">
            <thead><tr><th>Vendor</th><th>Contact</th><th>GSTIN</th><th>Payment Terms</th><th className="text-right">Outstanding</th><th className="text-right">Total Purchases</th><th></th></tr></thead>
            <tbody>
              {filtered.map(v => (
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
                  <td className="text-right mono">{fmt(v.total_purchases)}</td>
                  <td>
                    <div style={{display:'flex',gap:4}}>
                      <button className="btn btn-ghost btn-xs" onClick={() => openEdit(v)}>Edit</button>
                      <button className="btn btn-primary btn-xs" onClick={() => openHistory(v)}>History</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Modal open={showAdd} onClose={()=>setShowAdd(false)} title="Add Vendor" icon="🏭" size="md"
        footer={<><button className="btn btn-secondary" onClick={()=>setShowAdd(false)}>Cancel</button><button className="btn btn-primary" onClick={save}>Save Vendor</button></>}>
        <FormRow><FormGroup label="Company / Vendor Name" required><input className="form-input" value={form.name} onChange={e=>pf('name',e.target.value)} /></FormGroup>
        <FormGroup label="Contact Person"><input className="form-input" value={form.contact_person} onChange={e=>pf('contact_person',e.target.value)} /></FormGroup></FormRow>
        <FormRow><FormGroup label="Phone"><input className="form-input" value={form.phone} onChange={e=>pf('phone',e.target.value)} /></FormGroup>
        <FormGroup label="Email"><input className="form-input" type="email" value={form.email} onChange={e=>pf('email',e.target.value)} /></FormGroup></FormRow>
        <FormGroup label="Address"><textarea className="form-input" style={{height:64}} value={form.address} onChange={e=>pf('address',e.target.value)} /></FormGroup>
        <FormRow><FormGroup label="GSTIN"><input className="form-input" value={form.gstin} onChange={e=>pf('gstin',e.target.value)} placeholder="15-digit GSTIN" /></FormGroup>
        <FormGroup label="Payment Terms"><select className="form-input" value={form.payment_terms} onChange={e=>pf('payment_terms',e.target.value)}>{['Advance','COD','7 days','15 days','30 days','45 days','60 days','Weekly'].map(t=><option key={t}>{t}</option>)}</select></FormGroup></FormRow>
      </Modal>

      <Modal open={showEdit} onClose={()=>setShowEdit(false)} title="Edit Vendor" icon="✏️" size="md"
        footer={<><button className="btn btn-secondary" onClick={()=>setShowEdit(false)}>Cancel</button><button className="btn btn-primary" onClick={saveEdit}>Save Changes</button></>}>
        <FormRow><FormGroup label="Company / Vendor Name" required><input className="form-input" value={form.name} onChange={e=>pf('name',e.target.value)} /></FormGroup>
        <FormGroup label="Contact Person"><input className="form-input" value={form.contact_person} onChange={e=>pf('contact_person',e.target.value)} /></FormGroup></FormRow>
        <FormRow><FormGroup label="Phone"><input className="form-input" value={form.phone} onChange={e=>pf('phone',e.target.value)} /></FormGroup>
        <FormGroup label="Email"><input className="form-input" type="email" value={form.email} onChange={e=>pf('email',e.target.value)} /></FormGroup></FormRow>
        <FormGroup label="Address"><textarea className="form-input" style={{height:64}} value={form.address} onChange={e=>pf('address',e.target.value)} /></FormGroup>
        <FormRow><FormGroup label="GSTIN"><input className="form-input" value={form.gstin} onChange={e=>pf('gstin',e.target.value)} placeholder="15-digit GSTIN" /></FormGroup>
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
    </div>
  )
}
