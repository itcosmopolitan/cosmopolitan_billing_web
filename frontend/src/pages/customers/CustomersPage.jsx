import { useState, useEffect, useMemo } from 'react'
import toast from 'react-hot-toast'
import { customersAPI } from '@/api'
import { useAppStore, subscribeToBranchChanged } from '@/store'
import { useCan } from '@/auth/permissions'
import { fmt, exportToCSV, formatLabel } from '@/utils/helpers'
import { SectionHeader, Card, SearchBar, Chip, KPICard, Modal, EmptyState, ProgressBar, Tag, PaginationBar, SortableHeader, AutocompleteDropdown, TableLoadingPanel, PageActionsMenu, buildListPageMenuActions, RowActionsMenu, CustomizeColumnsModal, ColumnPrefsTrigger, ColumnPrefsSpacer } from '@/components/ui'
import { CUSTOMER_TYPE_OPTIONS, CUSTOMER_TYPE_LABELS } from '@/utils/dropdownOptions'
import CustomerFormModal from './CustomerFormModal'
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
  const [editingCustomer, setEditingCustomer] = useState(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importFile, setImportFile] = useState(null)
  const [importBusy, setImportBusy] = useState(false)
  const [importResult, setImportResult] = useState(null)
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

  const openAddCustomerModal = () => {
    setEditingCustomer(null)
    setCustomerModalOpen(true)
  }

  const openEditCustomerModal = (customer) => {
    setEditingCustomer(customer)
    setCustomerModalOpen(true)
  }

  const closeCustomerModal = () => {
    setCustomerModalOpen(false)
    setEditingCustomer(null)
  }

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

  if (loading) {
    return (
      <div className="page-container">
        <TableLoadingPanel label="Loading customers…" />
      </div>
    )
  }

  const creditUsedPct = (c) => {
    const owed = Math.max(0, Number(c.outstanding) || 0)
    return c.creditLimit > 0 ? Math.min(100, (owed / c.creditLimit) * 100) : 0
  }

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
          <>
            <button className="btn btn-primary btn-sm" onClick={openAddCustomerModal}>+ Add Customer</button>
            <button className="btn btn-primary btn-sm" onClick={() => setImportOpen(true)} style={{ marginLeft: 8 }}>Import</button>
          </>
        )}
        <PageActionsMenu actions={buildListPageMenuActions({
          onExport: () => {
            exportToCSV(customers.map((c) => ({
              Name: c.name,
              Phone: c.phone || '—',
              Email: c.email || '—',
              Address: c.address || '—',
              'GST Reg No': c.gstIn || '—',
              Type: formatLabel(c.type || 'Retail'),
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

      <Modal
        open={importOpen}
        onClose={() => !importBusy && setImportOpen(false)}
        title="Import Customers"
        icon="⬆️"
        size="lg"
        footer={<>
          <button className="btn btn-secondary" onClick={() => setImportOpen(false)} disabled={importBusy}>Close</button>
          <button className="btn btn-primary" onClick={async () => {
            if (!importFile) { toast.error('Select a file to upload'); return }
            if (!activeBranch?.id) { toast.error('Select a branch before importing'); return }
            setImportBusy(true)
            try {
              const res = await customersAPI.import(importFile, activeBranch.id)
              setImportResult(res)
              toast.success(`${res.created || 0} customers imported`)
              setListVersion((v) => v + 1)
              setImportFile(null)
            } catch (err) {
              console.error('Customer import failed', err)
              const detail = err?.response?.data?.detail
              const message =
                typeof detail === 'string'
                  ? detail
                  : detail?.message ||
                    (Array.isArray(detail)
                      ? detail.map((item) => item?.msg || item?.message || JSON.stringify(item)).join(', ')
                      : err?.message || 'Customer import failed')
              toast.error(message)
            } finally {
              setImportBusy(false)
            }
          }} disabled={importBusy}>{importBusy ? 'Uploading…' : 'Upload'}</button>
        </>}
      >
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'left', lineHeight: 1.45 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Upload instructions</div>
            <div>Customers will be added to the currently selected branch. Name, Street 1, City, and Country are required.</div>
            <div style={{ marginTop: 6 }}><strong>Columns:</strong> Customer Name, Phone, Email, GST Reg No, Street 1, Street 2, Street 3, City, State/Province, Country, Postal Code, Credit Limit, Customer Type, Key Account Manager, Credit Terms</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input type="file" accept=".xlsx,.xls" onChange={(e) => setImportFile(e.target.files?.[0] || null)} />
            <button className="btn btn-ghost btn-sm" onClick={async () => {
              try {
                const blob = await customersAPI.downloadTemplate()
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = 'customer_import_template.xlsx'
                document.body.appendChild(a)
                a.click()
                a.remove()
                URL.revokeObjectURL(url)
              } catch (err) {
                console.error('Failed to download customer template', err)
                toast.error(err?.response?.data?.detail || err?.message || 'Failed to download customer template')
              }
            }}>Download template</button>
          </div>
          {importResult && importResult.errors && importResult.errors.length > 0 && (
            <div style={{ maxHeight: 200, overflowY: 'auto', padding: 8, background: 'var(--bg-raised)', borderRadius: 6 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Errors</div>
              {importResult.errors.map((err) => <div key={err.row} style={{ fontSize: 13 }}>[Row {err.row}] {err.error}</div>)}
            </div>
          )}
        </div>
      </Modal>

      {/* <div className="grid-kpi" style={{ marginBottom: 20 }}>
        <KPICard label="Total Customers"    value={totals.total}                    color="var(--accent)" icon="👥" />
        <KPICard label="Outstanding Total"  value={fmt(totals.outstanding)}         color="var(--red)"   icon="📋" />
        <KPICard label="With Balance Due"   value={totals.overdue}                  color="var(--amber)" icon="⚠️" />
        <KPICard label="Top Buyer"          value={totals.topBuyer?.name?.split(' ')[0] || '—'} color="var(--green)" icon="🏆" sub={totals.topBuyer ? fmt(totals.topBuyer.total_purchases || 0) : '—'} />
      </div> */}

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
                            style={{ color: c.outstanding > 0 ? 'var(--red)' : c.outstanding < 0 ? 'var(--green)' : undefined }}
                            title={c.outstanding < 0 ? 'Account credit (negative outstanding)' : undefined}
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

      <CustomerFormModal
        open={customerModalOpen}
        onClose={closeCustomerModal}
        customer={editingCustomer}
        defaultBranchId={activeBranch?.id || branches[0]?.id}
        onSaved={() => setListVersion((v) => v + 1)}
      />

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
