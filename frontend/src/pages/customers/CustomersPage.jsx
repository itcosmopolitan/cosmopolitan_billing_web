import { useState, useEffect, useMemo, useCallback } from 'react'
import toast from 'react-hot-toast'
import { customersAPI, AUTOCOMPLETE_BRANCH_URL } from '@/api'
import { useAppStore, subscribeToBranchChanged } from '@/store'
import { useCan } from '@/auth/permissions'
import { fmt, exportToCSV } from '@/utils/helpers'
import { decomposeAddress } from '@/utils/address'
import { SectionHeader, Card, SearchBar, Chip, KPICard, Modal, FormGroup, FormRow, EmptyState, ProgressBar, Tag, AlertBar, PaginationBar, SortableHeader, AutocompleteDropdown, TableLoadingPanel, PageActionsMenu, buildListPageMenuActions } from '@/components/ui'
import { CUSTOMER_TYPE_OPTIONS } from '@/utils/dropdownOptions'
import { unwrapPaged, DEFAULT_PAGE_SIZE, fetchAllList } from '@/utils/pagination'

export default function CustomersPage() {
  const can = useCan()
  const [search, setSearch]     = useState('')
  const [typeF, setTypeF]       = useState('')
  const [customerModalOpen, setCustomerModalOpen] = useState(false)
  const [customerModalMode, setCustomerModalMode] = useState('add')
  const [editingCustomer, setEditingCustomer] = useState(null)
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
  const activeBranch = useAppStore((s) => s.activeBranch)
  const [loading, setLoading]   = useState(true)
  const [listVersion, setListVersion] = useState(0)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    name: '',
    phone: '',
    email: '',
    gst_in: '',
    street1: '',
    street2: '',
    street3: '',
    city: '',
    stateProvince: '',
    country: '',
    postalCode: '',
    branch_id: '',
    credit_limit: '10000',
    customer_type: 'retail',
  })

  const pf = (k,v) => setForm(f=>({...f,[k]:v}))

  const resetCustomerForm = (initial = {}) => {
    setForm({
      name: '',
      phone: '',
      email: '',
      gst_in: '',
      street1: '',
      street2: '',
      street3: '',
      city: '',
      stateProvince: '',
      country: '',
      postalCode: '',
      branch_id: initial.branch_id || '',
      credit_limit: initial.credit_limit ?? '10000',
      customer_type: initial.customer_type || 'retail',
      ...initial,
    })
  }

  const openAddCustomerModal = () => {
    resetCustomerForm({
      branch_id: branches[0]?.id || '',
      credit_limit: '10000',
      customer_type: 'retail',
    })
    setEditingCustomer(null)
    setCustomerModalMode('add')
    setCustomerModalOpen(true)
  }

  const openEditCustomerModal = (customer) => {
    const structured = {
      street1: customer.street1 || '',
      street2: customer.street2 || '',
      street3: customer.street3 || '',
      city: customer.city || '',
      stateProvince: customer.state_province || '',
      country: customer.country || '',
      postalCode: customer.postal_code || '',
    }
    const hasStructured = Boolean(
      structured.street1 || structured.street2 || structured.street3 ||
      structured.city || structured.stateProvince || structured.country || structured.postalCode
    )
    const addressParts = hasStructured ? structured : decomposeAddress(customer.address)
    resetCustomerForm({
      name: customer.name || '',
      phone: customer.phone || '',
      email: customer.email || '',
      gst_in: customer.gst_in || customer.gstin || '',
      ...addressParts,
      branch_id: customer.branch_id || '',
      credit_limit: customer.credit_limit != null ? String(customer.credit_limit) : '0',
      customer_type: customer.customer_type || customer.type || 'retail',
    })
    setEditingCustomer(customer)
    setCustomerModalMode('edit')
    setCustomerModalOpen(true)
  }

  const closeCustomerModal = () => {
    setCustomerModalOpen(false)
    setEditingCustomer(null)
  }

  useEffect(() => {
    if (branches.length > 0 && !form.branch_id) {
      setForm((f) => ({ ...f, branch_id: branches[0].id }))
    }
  }, [branches, form.branch_id])

  useEffect(() => {
    setCustSkip(0)
  }, [search, typeF])

  useEffect(() => {
    const unsub = subscribeToBranchChanged(() => {
      setCustSkip(0)
      setListVersion((v) => v + 1)
    })
    return () => unsub()
  }, [])

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
  }, [custSkip, custLimit, search, typeF, listVersion, custSortBy, custSortOrder, activeBranch?.id])

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

  const validateEmail = (email) => {
    if (!email) return true
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  }

  const saveCustomer = async () => {
    if (saving) return
    if (!form.name?.trim()) { toast.error('Customer name required'); return }
    if (!form.branch_id) { toast.error('Select a branch'); return }
    if (!branches.find((b) => b.id === form.branch_id)) { toast.error('Select a valid branch'); return }
    if (!form.street1?.trim()) { toast.error('Street 1 is required'); return }
    if (!form.city?.trim()) { toast.error('City is required'); return }
    if (!form.country?.trim()) { toast.error('Country is required'); return }
    if (!validateEmail(form.email?.trim())) { toast.error('Enter a valid email address'); return }

    const token = localStorage.getItem('retailos_token')
    if (!token) { toast.error('Not authenticated'); return }

    setSaving(true)
    try {
      const payload = {
        name: form.name.trim(),
        phone: form.phone?.trim() || undefined,
        email: form.email?.trim() || undefined,
        address: '',
        gst_in: form.gst_in?.trim() || undefined,
        branch_id: form.branch_id,
        credit_limit: Number(form.credit_limit) || 0,
        customer_type: form.customer_type,
        street1: form.street1?.trim(),
        street2: form.street2?.trim() || undefined,
        street3: form.street3?.trim() || undefined,
        city: form.city?.trim(),
        state_province: form.stateProvince?.trim() || undefined,
        country: form.country?.trim(),
        postal_code: form.postalCode?.trim() || undefined,
      }

      if (customerModalMode === 'add') {
        await customersAPI.create(payload)
        toast.success('Customer added successfully')
      } else if (customerModalMode === 'edit' && editingCustomer) {
        await customersAPI.update(editingCustomer.id, payload)
        toast.success('Customer updated successfully')
      } else {
        toast.error('Unable to save customer')
        return
      }

      setListVersion((v) => v + 1)
      setCustomerModalOpen(false)
      setEditingCustomer(null)
    } catch (err) {
      console.error('Failed to save customer:', err)
      const detail = err?.response?.data?.detail
      const message =
        typeof detail === 'string'
          ? detail
          : detail?.message || err?.message || 'Failed to save customer'
      if (err?.response?.status === 401) {
        toast.error('Session expired, please log in again')
      } else {
        toast.error(message)
      }
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="page-container">
        <TableLoadingPanel label="Loading customers…" />
      </div>
    )
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
        {can('customers.create') && (
          <button className="btn btn-primary btn-sm" onClick={openAddCustomerModal}>+ Add Customer</button>
        )}
        <PageActionsMenu actions={buildListPageMenuActions({
          onExport: () => {
            exportToCSV(customers.map((c) => ({
              Name: c.name,
              Phone: c.phone || '—',
              Email: c.email || '—',
              Address: c.address || '—',
              'GST Reg No': c.gstIn || '—',
              Type: (c.type || 'Retail').charAt(0).toUpperCase() + (c.type || 'Retail').slice(1),
              'Credit Limit (MVR)': c.creditLimit || 0,
              'Outstanding (MVR)': c.outstanding || 0,
              'Total Purchases (MVR)': c.totalPurchases || 0,
            })), `Customers_${new Date().toISOString().split('T')[0]}.csv`)
            toast.success('Customers exported')
          },
          onRefresh: () => {
            setListVersion((v) => v + 1)
            toast.success('List refreshed')
          },
        })} />
      </SectionHeader>

      <div className="grid-kpi" style={{ marginBottom: 20 }}>
        <KPICard label="Total Customers"    value={totals.total}                    color="var(--accent)" icon="👥" />
        <KPICard label="Outstanding Total"  value={fmt(totals.outstanding)}         color="var(--red)"   icon="📋" />
        <KPICard label="With Balance Due"   value={totals.overdue}                  color="var(--amber)" icon="⚠️" />
        <KPICard label="Top Buyer"          value={totals.topBuyer?.name?.split(' ')[0] || '—'} color="var(--green)" icon="🏆" sub={totals.topBuyer ? fmt(totals.topBuyer.total_purchases || 0) : '—'} />
      </div>

      <div className="filter-bar">
        <SearchBar value={search} onChange={setSearch} placeholder="Search name, phone, email…" />
        <AutocompleteDropdown
          value={typeF}
          onChange={setTypeF}
          options={CUSTOMER_TYPE_OPTIONS}
          prependOptions={[{ id: '', label: 'All Types' }]}
          isSearchFieldRequired={false}
          placeholder="All Types"
          style={{ width: 140 }}
        />
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
                          <button className="btn btn-ghost btn-xs" onClick={() => openEditCustomerModal(c)}>Edit</button>
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

      {/* Add / Edit Customer */}
      <Modal
        open={customerModalOpen}
        onClose={closeCustomerModal}
        title={customerModalMode === 'edit' ? 'Edit Customer' : 'Add Customer'}
        icon="👤"
        size="md"
        busy={saving}
        footer={<>
          <button className="btn btn-secondary" onClick={closeCustomerModal} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={saveCustomer} disabled={saving}>{saving ? 'Saving…' : customerModalMode === 'edit' ? 'Save Changes' : 'Save Customer'}</button>
        </>}
      >
        <FormRow>
          <FormGroup label="Name" required>
            <input className="form-input" value={form.name} onChange={e => pf('name', e.target.value)} placeholder="Full name or company" />
          </FormGroup>
          <FormGroup label="Phone">
            <input className="form-input" value={form.phone} onChange={e => pf('phone', e.target.value)} placeholder="10-digit mobile" />
          </FormGroup>
        </FormRow>
        <FormRow>
          <FormGroup label="Email">
            <input className="form-input" type="email" value={form.email} onChange={e => pf('email', e.target.value)} />
          </FormGroup>
          <FormGroup label="GST Reg No">
            <input className="form-input" value={form.gst_in} onChange={e => pf('gst_in', e.target.value)} placeholder="For business customers" />
          </FormGroup>
        </FormRow>
        <FormGroup label="Street 1" required>
          <input className="form-input" maxLength={30} value={form.street1} onChange={e => pf('street1', e.target.value)} placeholder="Street address line 1" />
        </FormGroup>
        <FormRow>
          <FormGroup label="Street 2">
            <input className="form-input" maxLength={30} value={form.street2} onChange={e => pf('street2', e.target.value)} placeholder="Street address line 2" />
          </FormGroup>
          <FormGroup label="Street 3">
            <input className="form-input" maxLength={30} value={form.street3} onChange={e => pf('street3', e.target.value)} placeholder="Street address line 3" />
          </FormGroup>
        </FormRow>
        <FormRow>
          <FormGroup label="City" required>
            <input className="form-input" value={form.city} onChange={e => pf('city', e.target.value)} placeholder="City" />
          </FormGroup>
          <FormGroup label="State / Province">
            <input className="form-input" value={form.stateProvince} onChange={e => pf('stateProvince', e.target.value)} placeholder="State or province" />
          </FormGroup>
        </FormRow>
        <FormRow>
          <FormGroup label="Country" required>
            <input className="form-input" value={form.country} onChange={e => pf('country', e.target.value)} placeholder="Country" />
          </FormGroup>
          <FormGroup label="Postal Code / Zipcode">
            <input className="form-input" value={form.postalCode} onChange={e => pf('postalCode', e.target.value)} placeholder="Postal code or zipcode" />
          </FormGroup>
        </FormRow>
        <FormRow>
          <FormGroup label="Primary Branch" required>
            <AutocompleteDropdown
              value={form.branch_id}
              onChange={(v) => pf('branch_id', v)}
              fetchUrl={AUTOCOMPLETE_BRANCH_URL}
              fetchParams={{ retail_only: true }}
              prependOptions={[
                { id: '', label: 'Select branch…' },
                ...(form.branch_id && branches.find((b) => b.id === form.branch_id)
                  ? [{ id: form.branch_id, label: branches.find((b) => b.id === form.branch_id).name }]
                  : []),
              ]}
              isSearchFieldRequired={false}
              placeholder="Select branch…"
            />
          </FormGroup>
          <FormGroup label="Type">
            <AutocompleteDropdown value={form.customer_type} onChange={(v) => pf('customer_type', v)} options={CUSTOMER_TYPE_OPTIONS} isSearchFieldRequired={false} />
          </FormGroup>
        </FormRow>
        <FormGroup label="Credit Limit (MVR)">
          <input className="form-input" type="number" value={form.credit_limit} onChange={e => pf('credit_limit', e.target.value)} />
        </FormGroup>
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
