import { useRef, useState } from 'react'
import * as Icon from '@/components/ui/Icons'
import PermissionGate from './PermissionGate'

export default function ExportMenu({ onExport, disabled = false }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  const handleExport = (format) => {
    setOpen(false)
    onExport(format)
  }

  return (
    <PermissionGate permission="dashboard.export">
      <div ref={ref} style={{ position: 'relative' }}>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setOpen((v) => !v)}
          disabled={disabled}
          title="Export dashboard"
        >
          <Icon.Download size={15} />
          Export
        </button>
        {open && (
          <div
            style={{
              position: 'absolute',
              right: 0,
              top: 'calc(100% + 6px)',
              minWidth: 148,
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-default)',
              borderRadius: 8,
              boxShadow: 'var(--shadow-md)',
              padding: 4,
              zIndex: 200,
            }}
          >
            {['excel', 'pdf', 'csv'].map((format) => (
              <button
                key={format}
                type="button"
                className="btn btn-ghost"
                style={{ width: '100%', justifyContent: 'flex-start', textTransform: 'uppercase' }}
                onClick={() => handleExport(format)}
              >
                {format}
              </button>
            ))}
          </div>
        )}
      </div>
    </PermissionGate>
  )
}
