import { useEffect, useState } from 'react'
import { vendorsAPI } from '@/api'
import { fmt } from '@/utils/helpers'
import { Chip, AlertBar } from '@/components/ui'
import RecordDetailDrawer, { DetailFields, DetailSection } from '@/components/detail/RecordDetailDrawer'

function mapVendor(v) {
  if (!v) return null
  return {
    ...v,
    creditBalance: v.credit_balance ?? v.creditBalance ?? 0,
    totalPurchases: v.total_purchases ?? v.totalPurchases ?? 0,
    outstanding: v.outstanding || 0,
  }
}

export default function VendorDetailPanel({ open, vendor, onClose, onOpenLedger }) {
  const [detail, setDetail] = useState(() => mapVendor(vendor))
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState('overview')

  useEffect(() => {
    if (!open || !vendor?.id) return
    setTab('overview')
    setDetail(mapVendor(vendor))
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const full = await vendorsAPI.get(vendor.id)
        if (!cancelled) setDetail(mapVendor({ ...vendor, ...full }))
      } catch {
        /* list row is enough */
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [open, vendor?.id])

  const summary = [
    { label: 'Outstanding', value: fmt(detail?.outstanding), tone: detail?.outstanding > 0 ? 'var(--red)' : 'var(--green)' },
    { label: 'Vendor credit', value: detail?.creditBalance > 0 ? fmt(detail.creditBalance) : '—', tone: detail?.creditBalance > 0 ? 'var(--accent)' : undefined },
    { label: 'Total purchases', value: fmt(detail?.totalPurchases) },
    { label: 'Payment terms', value: detail?.payment_terms || '—' },
  ]

  return (
    <RecordDetailDrawer
      open={open}
      onClose={onClose}
      icon="🏭"
      title={detail?.name || 'Vendor'}
      subtitle={[detail?.contact_person, detail?.gstin].filter(Boolean).join(' · ') || 'Vendor details'}
      size="lg"
      summary={summary}
      tabs={[
        { id: 'overview', label: 'Vendor details' },
        { id: 'accounts', label: 'Accounts' },
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
          Credit ledger
        </button>
      )}
    >
      {loading && <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 12 }}>Loading details…</div>}

      {tab === 'overview' && (
        <>
          <DetailSection title="Contact">
            <DetailFields fields={[
              { label: 'Company / vendor', value: detail?.name },
              { label: 'Contact person', value: detail?.contact_person || '—' },
              { label: 'Phone', value: detail?.phone || '—' },
              { label: 'Email', value: detail?.email || '—' },
              { label: 'GSTIN', value: detail?.gstin || '—' },
              { label: 'Status', value: <Chip status={detail?.active ? 'active' : 'inactive'} /> },
            ]}
            />
          </DetailSection>
          <DetailSection title="Address">
            <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>{detail?.address || '—'}</div>
          </DetailSection>
        </>
      )}

      {tab === 'accounts' && (
        <>
          <DetailSection title="Payables">
            <DetailFields fields={[
              { label: 'Payment terms', value: detail?.payment_terms || '—' },
              {
                label: 'Outstanding',
                value: <span style={{ color: detail?.outstanding > 0 ? 'var(--red)' : 'var(--green)' }}>{fmt(detail?.outstanding)}</span>,
              },
              {
                label: 'Vendor credit',
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
              Outstanding payable of <strong>{fmt(detail.outstanding)}</strong>.
            </AlertBar>
          )}
        </>
      )}
    </RecordDetailDrawer>
  )
}
