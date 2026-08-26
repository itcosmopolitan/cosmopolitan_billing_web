import { useEffect, useState } from 'react'
import { customersAPI } from '@/api'
import { useAppStore } from '@/store'
import { fmt } from '@/utils/helpers'
import { Chip, AlertBar, Tag } from '@/components/ui'
import RecordDetailDrawer, { DetailFields, DetailSection } from '@/components/detail/RecordDetailDrawer'
import { CUSTOMER_TYPE_LABELS } from '@/utils/dropdownOptions'

function mapCustomer(c) {
  if (!c) return null
  return {
    ...c,
    type: c.customer_type || c.type,
    gstIn: c.gst_in || c.gstin || c.gstIn,
    branchId: c.branch_id || c.branchId,
    creditLimit: c.credit_limit ?? c.creditLimit,
    outstanding: c.outstanding || 0,
    creditBalance: c.credit_balance ?? c.creditBalance ?? 0,
    totalPurchases: c.total_purchases ?? c.totalPurchases ?? 0,
    keyAccountManager: c.key_account_manager_name || c.keyAccountManager || c.key_account_manager || '',
    creditTerms: c.credit_terms || c.creditTerms || '',
    customerCode: c.customer_code || c.customerCode,
  }
}

function creditUsedPct(c) {
  if (!c?.creditLimit) return 0
  return Math.min(100, ((c.outstanding || 0) / c.creditLimit) * 100)
}

export default function CustomerDetailPanel({ open, customer, onClose, onOpenLedger, branchName }) {
  const branches = useAppStore((s) => s.branches)
  const [detail, setDetail] = useState(() => mapCustomer(customer))
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState('overview')

  useEffect(() => {
    if (!open || !customer?.id) return
    setTab('overview')
    setDetail(mapCustomer(customer))
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const full = await customersAPI.get(customer.id)
        if (!cancelled) setDetail(mapCustomer({ ...customer, ...full }))
      } catch {
        /* list row is enough */
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [open, customer?.id])

  const branchLabel = branchName
    || branches.find((b) => b.id === detail?.branchId)?.name
    || detail?.branchId
    || '—'

  const addressLines = [
    detail?.street1,
    detail?.street2,
    detail?.street3,
    [detail?.city, detail?.state_province || detail?.stateProvince].filter(Boolean).join(', '),
    [detail?.country, detail?.postal_code || detail?.postalCode].filter(Boolean).join(' '),
    !detail?.street1 && detail?.address ? detail.address : null,
  ].filter((line) => typeof line === 'string' && line.trim())

  const summary = [
    { label: 'Outstanding', value: fmt(detail?.outstanding), tone: detail?.outstanding > 0 ? 'var(--red)' : 'var(--green)' },
    { label: 'Store credit', value: detail?.creditBalance > 0 ? fmt(detail.creditBalance) : '—', tone: detail?.creditBalance > 0 ? 'var(--accent)' : undefined },
    { label: 'Account limit', value: fmt(detail?.creditLimit) },
    { label: 'Total purchases', value: fmt(detail?.totalPurchases) },
  ]

  return (
    <RecordDetailDrawer
      open={open}
      onClose={onClose}
      icon="👤"
      title={detail?.name || 'Customer'}
      subtitle={[detail?.customerCode, CUSTOMER_TYPE_LABELS[detail?.type] || 'Retail'].filter(Boolean).join(' · ')}
      size="lg"
      summary={summary}
      tabs={[
        { id: 'overview', label: 'Customer details' },
        { id: 'credit', label: 'Account & store credit' },
      ]}
      activeTab={tab}
      onTabChange={setTab}
      headerActions={(
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => {
            onOpenLedger?.(detail)
            onClose?.()
          }}
        >
          Store credit ledger
        </button>
      )}
    >
      {loading && <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 12 }}>Loading details…</div>}

      {tab === 'overview' && (
        <>
          <DetailSection title="Contact">
            <DetailFields fields={[
              { label: 'Customer name', value: detail?.name },
              { label: 'Customer ID', value: <span className="mono">{detail?.customerCode || '—'}</span> },
              { label: 'Phone', value: detail?.phone || '—' },
              { label: 'Email', value: detail?.email || '—' },
              { label: 'GST Reg No', value: detail?.gstIn || '—' },
              { label: 'Branch', value: branchLabel },
              { label: 'Status', value: <Chip status={detail?.active ? 'active' : 'inactive'} /> },
            ]}
            />
          </DetailSection>
          <DetailSection title="Address">
            {addressLines.length ? (
              <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-primary)' }}>
                {addressLines.map((line) => <div key={line}>{line}</div>)}
              </div>
            ) : (
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No address on file</div>
            )}
          </DetailSection>
        </>
      )}

      {tab === 'credit' && (
        <>
          <DetailSection title="Pricing & terms">
            <DetailFields fields={[
              {
                label: 'Pricing category',
                value: (
                  <Tag color={detail?.type === 'wholesale' ? 'var(--purple)' : detail?.type === 'staff' ? 'var(--accent)' : undefined}>
                    {CUSTOMER_TYPE_LABELS[detail?.type] || 'Retail'}
                  </Tag>
                ),
              },
              { label: 'Key account manager', value: detail?.keyAccountManager || '—' },
              { label: 'Credit terms', value: detail?.creditTerms || '—' },
              { label: 'Account limit', value: fmt(detail?.creditLimit) },
              {
                label: 'Outstanding',
                value: <span style={{ color: detail?.outstanding > 0 ? 'var(--red)' : 'var(--green)' }}>{fmt(detail?.outstanding)}</span>,
              },
              {
                label: 'Store credit',
                value: detail?.creditBalance > 0
                  ? <span style={{ color: 'var(--accent)' }}>{fmt(detail.creditBalance)}</span>
                  : '—',
              },
              { label: 'Total purchases', value: fmt(detail?.totalPurchases) },
            ]}
            />
          </DetailSection>
          {detail?.outstanding > 0 && (
            <AlertBar type="amber" icon="⚠️">
              Outstanding balance of <strong>{fmt(detail.outstanding)}</strong> — {Math.round(creditUsedPct(detail))}% of account limit used.
            </AlertBar>
          )}
        </>
      )}
    </RecordDetailDrawer>
  )
}
