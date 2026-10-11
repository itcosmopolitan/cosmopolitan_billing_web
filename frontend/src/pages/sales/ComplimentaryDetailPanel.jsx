import { useState } from 'react'
import { fmt } from '@/utils/helpers'
import RecordDetailDrawer, { DetailFields, DetailSection } from '@/components/detail/RecordDetailDrawer'
import { NOT_SET } from '@/utils/emptyValue'

export default function ComplimentaryDetailPanel({ open, onClose, entry, onPrint, onExport }) {
  const [tab, setTab] = useState('overview')
  const lines = entry?.items || []

  const summary = [
    { label: 'Amount (cost) (MVR)', value: fmt(entry?.cost_value) },
    { label: 'Lines', value: lines.length },
    { label: 'Reason', value: entry?.reason || NOT_SET },
    { label: 'Taxable amount (MVR)', value: fmt(0) },
  ]

  const footer = (
    <>
      <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={!entry}
        onClick={() => {
          onPrint?.(entry)
          onClose?.()
        }}
      >
        Print
      </button>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={!entry}
        onClick={() => {
          onExport?.(entry)
          onClose?.()
        }}
      >
        Export PDF
      </button>
    </>
  )

  return (
    <RecordDetailDrawer
      open={open}
      onClose={onClose}
      icon="🎁"
      title={entry?.number || 'Complimentary'}
      subtitle={[entry?.customer_name || 'Walk-in', entry?.date].filter(Boolean).join(' · ')}
      size="xl"
      summary={summary}
      footer={footer}
      tabs={[
        { id: 'overview', label: 'Complimentary details' },
        { id: 'lines', label: `Line items (${lines.length})` },
      ]}
      activeTab={tab}
      onTabChange={setTab}
    >
      {tab === 'overview' && (
        <>
          <DetailSection title="Basic info">
            <DetailFields fields={[
              { label: 'Customer', value: entry?.customer_name || 'Walk-in' },
              { label: 'Branch', value: entry?.branch_name || NOT_SET },
              { label: 'Reason', value: entry?.reason || NOT_SET },
              { label: 'Date', value: entry?.date || NOT_SET },
              { label: 'Cashier', value: entry?.created_by || NOT_SET },
            ]}
            />
          </DetailSection>
          {entry?.notes ? (
            <DetailSection title="Remarks">
              <div style={{ fontSize: 13 }}>{entry.notes}</div>
            </DetailSection>
          ) : null}
        </>
      )}

      {tab === 'lines' && (
        <DetailSection title="Items">
          <table className="data-table">
            <thead>
              <tr>
                <th>Item</th>
                <th className="text-right">Qty</th>
                <th className="text-right">Rate (Cost) (MVR)</th>
                <th className="text-right">Total (Cost) (MVR)</th>
                <th>Lots</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, idx) => (
                <tr key={`${line.name}-${idx}`}>
                  <td style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{line.name}</td>
                  <td className="text-right">{line.qty} {line.unit}</td>
                  <td className="text-right">{fmt(line.cost_price)}</td>
                  <td className="text-right">{fmt(line.cost_total)}</td>
                  <td>
                    {line.lots?.length
                      ? line.lots.map((lot, i) => (
                          <div key={`${lot.batch_id}-${i}`} style={{ fontSize: 12 }}>
                            {lot.qty} from batch {lot.batch_id}
                          </div>
                        ))
                      : NOT_SET}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </DetailSection>
      )}
    </RecordDetailDrawer>
  )
}
