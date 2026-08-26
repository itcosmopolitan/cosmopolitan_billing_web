import { useState, useEffect, useMemo, useCallback } from 'react'
import toast from 'react-hot-toast'
import { customersAPI, AUTOCOMPLETE_BRANCH_URL, AUTOCOMPLETE_BRANCH_USERS_URL } from '@/api'
import { useAppStore, subscribeToBranchChanged } from '@/store'
import { useCan } from '@/auth/permissions'
import { fmt, exportToCSV } from '@/utils/helpers'
import { decomposeAddress } from '@/utils/address'
import { SectionHeader, Card, SearchBar, Chip, KPICard, Modal, FormGroup, FormRow, EmptyState, ProgressBar, Tag, PaginationBar, SortableHeader, AutocompleteDropdown, TableLoadingPanel, PageActionsMenu, buildListPageMenuActions, RowActionsMenu, CustomizeColumnsModal, ColumnPrefsTrigger, ColumnPrefsSpacer } from '@/components/ui'
import { CUSTOMER_TYPE_OPTIONS, CUSTOMER_TYPE_LABELS } from '@/utils/dropdownOptions'
import { unwrapPaged, DEFAULT_PAGE_SIZE, fetchAllList } from '@/utils/pagination'
import { tableRowClickProps } from '@/utils/tableRowClick'
import useColumnPrefs from '@/hooks/useColumnPrefs'
import CustomerDetailPanel from './CustomerDetailPanel'

export default function CustomersPage() {
  const can = useCan()
  const columnPrefs = useColumnPrefs('customers.list')
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
    key_account_manager: '',
    key_account_manager_name: '',
    credit_terms: '',
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
      key_account_manager: initial.key_account_manager || '',
      key_account_manager_name: initial.key_account_manager_name || '',
      credit_terms: initial.credit_terms || '',
      ...initial,
    })
  }

  const openAddCustomerModal = () => {
    resetCustomerForm({
      branch_id: branches[0]?.id || '',
      credit_limit: '10000',
      customer_type: 'retail',
      key_account_manager: '',
      key_account_manager_name: '',
      credit_terms: '',
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
      key_account_manager: customer.keyAccountManagerId || customer.key_account_manager || '',
      key_account_manager_name: customer.keyAccountManager || customer.key_account_manager_name || '',
      credit_terms: customer.credit_terms || customer.creditTerms || '',
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
          keyAccountManager: c.key_account_manager_name || c.key_account_manager || '',
          keyAccountManagerId: c.key_account_manager || '',
          creditTerms: c.credit_terms || '',
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
        key_account_manager: form.key_account_manager?.trim() || null,
        credit_terms: form.credit_terms?.trim() || null,
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
      toast.error('Failed to load store credit ledger')
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
              'Account Limit (MVR)': c.creditLimit || 0,
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
          <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <ColumnPrefsTrigger onClick={columnPrefs.openCustomize} />
                {columnPrefs.visibleIds.map((id) => {
                  if (id === 'customer') {
                    return (
                      <SortableHeader
                        key={id}
                        label="Customer"
                        sortKey="name"
                        sortBy={custSortBy}
                        sortOrder={custSortOrder}
                        onSort={onSort}
                      />
                    )
                  }
                  if (id === 'contact') {
                    return (
                      <SortableHeader
                        key={id}
                        label="Contact"
                        sortKey="phone"
                        sortBy={custSortBy}
                        sortOrder={custSortOrder}
                        onSort={onSort}
                      />
                    )
                  }
                  if (id === 'pricing') {
                    return (
                      <SortableHeader
                        key={id}
                        label="Pricing"
                        sortKey="customer_type"
                        sortBy={custSortBy}
                        sortOrder={custSortOrder}
                        onSort={onSort}
                      />
                    )
                  }
                  if (id === 'kam') return <th key={id}>KAM</th>
                  if (id === 'branch') return <th key={id}>Branch</th>
                  if (id === 'credit_terms') return <th key={id}>Credit Terms</th>
                  if (id === 'account_limit') {
                    return (
                      <SortableHeader
                        key={id}
                        label="Account Limit"
                        sortKey="credit_limit"
                        sortBy={custSortBy}
                        sortOrder={custSortOrder}
                        onSort={onSort}
                        className="text-right"
                        align="right"
                      />
                    )
                  }
                  if (id === 'outstanding') {
                    return (
                      <SortableHeader
                        key={id}
                        label="Outstanding"
                        sortKey="outstanding"
                        sortBy={custSortBy}
                        sortOrder={custSortOrder}
                        onSort={onSort}
                        className="text-right"
                        align="right"
                      />
                    )
                  }
                  if (id === 'store_credit') {
                    return (
                      <th key={id} className="text-right" style={{ textAlign: 'right' }}>
                        Store Credit
                      </th>
                    )
                  }
                  if (id === 'limit_used') {
                    return <th key={id} style={{ width: 100 }}>Limit Used</th>
                  }
                  if (id === 'total_purchases') {
                    return (
                      <SortableHeader
                        key={id}
                        label="Total Purchases"
                        sortKey="total_purchases"
                        sortBy={custSortBy}
                        sortOrder={custSortOrder}
                        onSort={onSort}
                        className="text-right"
                        align="right"
                      />
                    )
                  }
                  if (id === 'status') return <th key={id}>Status</th>
                  return null
                })}
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {customers.map(c => {
                const pct = creditUsedPct(c)
                return (
                  <tr key={c.id} {...tableRowClickProps(() => setShowDetail(c))}>
                    <ColumnPrefsSpacer />
                    {columnPrefs.visibleIds.map((id) => {
                      if (id === 'customer') {
                        return (
                          <td key={id}>
                            <div style={{ fontWeight:500, color:'var(--text-primary)', fontSize:13 }}>{c.name}</div>
                            <div style={{ fontSize:11, color:'var(--text-muted)' }}>Customer ID: {c.customer_code || c.customerCode || '—'}</div>
                            <div style={{ fontSize:11, color:'var(--text-muted)' }}>{c.gstIn || 'No GST Reg No'}</div>
                          </td>
                        )
                      }
                      if (id === 'contact') {
                        return (
                          <td key={id}>
                            <div style={{ fontSize:12.5 }}>{c.phone}</div>
                            <div style={{ fontSize:11, color:'var(--text-muted)' }}>{c.email || '—'}</div>
                          </td>
                        )
                      }
                      if (id === 'pricing') {
                        return (
                          <td key={id}>
                            <Tag color={c.type==='wholesale' ? 'var(--purple)' : c.type === 'staff' ? 'var(--accent)' : undefined}>
                              {CUSTOMER_TYPE_LABELS[c.type] || 'Retail'}
                            </Tag>
                          </td>
                        )
                      }
                      if (id === 'kam') {
                        return <td key={id} style={{ fontSize:12 }}>{c.keyAccountManager || '—'}</td>
                      }
                      if (id === 'branch') {
                        return (
                          <td key={id} style={{ fontSize:12 }}>
                            {branches.find(b=>b.id===c.branchId)?.name || c.branchId}
                          </td>
                        )
                      }
                      if (id === 'credit_terms') {
                        return <td key={id} style={{ fontSize:12 }}>{c.creditTerms || '—'}</td>
                      }
                      if (id === 'account_limit') {
                        return <td key={id} className="text-right mono">{fmt(c.creditLimit)}</td>
                      }
                      if (id === 'outstanding') {
                        return (
                          <td
                            key={id}
                            className="text-right mono"
                            style={{ color: c.outstanding > 0 ? 'var(--red)' : 'var(--green)' }}
                          >
                            {fmt(c.outstanding)}
                          </td>
                        )
                      }
                      if (id === 'store_credit') {
                        return (
                          <td
                            key={id}
                            className="text-right mono"
                            style={{ color: c.creditBalance > 0 ? 'var(--accent)' : 'var(--text-muted)' }}
                          >
                            {c.creditBalance > 0 ? fmt(c.creditBalance) : '—'}
                          </td>
                        )
                      }
                      if (id === 'limit_used') {
                        return (
                          <td key={id}>
                            <ProgressBar value={pct} color={pct > 80 ? 'var(--red)' : pct > 50 ? 'var(--amber)' : 'var(--green)'} />
                            <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:2 }}>{Math.round(pct)}%</div>
                          </td>
                        )
                      }
                      if (id === 'total_purchases') {
                        return <td key={id} className="text-right mono">{fmt(c.totalPurchases)}</td>
                      }
                      if (id === 'status') {
                        return (
                          <td key={id}>
                            <Chip status={c.active ? 'active' : 'inactive'} />
                          </td>
                        )
                      }
                      return null
                    })}
                    <td className="text-right">
                      <RowActionsMenu
                        ariaLabel={`Actions for ${c.name}`}
                        actions={[
                          {
                            label: 'View',
                            onClick: () => setShowDetail(c),
                          },
                          {
                            label: 'Edit',
                            hidden: !can('customers.edit'),
                            onClick: () => openEditCustomerModal(c),
                          },
                          {
                            label: 'Store credit ledger',
                            onClick: () => openCreditLedger(c),
                          },
                        ]}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
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

      <CustomizeColumnsModal
        open={columnPrefs.customizeOpen}
        onClose={columnPrefs.closeCustomize}
        defs={columnPrefs.defs}
        value={columnPrefs.prefs}
        onSave={columnPrefs.savePrefs}
      />

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
              ]}
              isSearchFieldRequired={false}
              selectedLabel={form.branch_id && branches.find((b) => b.id === form.branch_id)?.name || undefined}
              placeholder="Select branch…"
            />
          </FormGroup>
          <FormGroup label="Pricing category" required>
            <AutocompleteDropdown value={form.customer_type} onChange={(v) => pf('customer_type', v)} options={CUSTOMER_TYPE_OPTIONS} isSearchFieldRequired={false} />
          </FormGroup>
        </FormRow>
        <FormRow>
          <FormGroup label="Key Account Manager">
            <AutocompleteDropdown
              value={form.key_account_manager}
              onSelectOption={(opt) => {
                if (!opt) {
                  pf('key_account_manager', '')
                  pf('key_account_manager_name', '')
                  return
                }
                pf('key_account_manager', opt.id)
                pf('key_account_manager_name', opt.label)
              }}
              fetchUrl={AUTOCOMPLETE_BRANCH_USERS_URL}
              fetchParams={{ branch_id: form.branch_id }}
              prependOptions={[{ id: '', label: 'None' }]}
              isSearchFieldRequired
              selectedLabel={form.key_account_manager_name || undefined}
              clearable
              onClear={() => {
                pf('key_account_manager', '')
                pf('key_account_manager_name', '')
              }}
              placeholder="Select user…"
              searchPlaceholder="Search users…"
              emptyLabel="No users found"
            />
          </FormGroup>
          <FormGroup label="Account limit (MVR)">
            <input className="form-input" type="number" value={form.credit_limit} onChange={e => pf('credit_limit', e.target.value)} />
          </FormGroup>
        </FormRow>
        <FormGroup label="Credit terms">
          <input
            className="form-input"
            value={form.credit_terms}
            onChange={e => pf('credit_terms', e.target.value)}
            placeholder="e.g. Cash, Net 7 days, Net 30 days"
          />
        </FormGroup>
      </Modal>

      <CustomerDetailPanel
        open={!!showDetail}
        customer={showDetail}
        onClose={() => setShowDetail(null)}
        onOpenLedger={openCreditLedger}
      />

      {/* Credit Ledger */}
      <Modal
        open={!!ledgerCustomer}
        onClose={() => setLedgerCustomer(null)}
        title={`Store credit ledger — ${ledgerCustomer?.name || ''}`}
        icon="💳"
        size="lg"
        footer={<button className="btn btn-secondary" onClick={() => setLedgerCustomer(null)}>Close</button>}
      >
        {ledgerCustomer && (
          <>
            <div style={{ display:'flex', gap:16, marginBottom:16, flexWrap:'wrap' }}>
              <div style={{ padding:'10px 14px', background:'var(--bg-raised)', borderRadius:8 }}>
                <div style={{ fontSize:11, color:'var(--text-muted)' }}>Store credit balance</div>
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
              <EmptyState icon="💳" title="No store credit movements yet" subtitle="Overpayments and return credits will appear here." />
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
