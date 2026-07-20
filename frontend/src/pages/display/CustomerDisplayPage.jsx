import { useState, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useDisplaySocket } from '@/hooks/useDisplaySocket'
import { settingsAPI } from '@/api'
import { EMPTY_POS_DISPLAY, isValidDisplayCode, normalizeDisplayCode } from './displayShared'
import { fmt } from '@/utils/helpers'

function DisplayCodeEntry() {
  const navigate = useNavigate()
  const [input, setInput] = useState('')
  const [error, setError] = useState('')

  const submit = (e) => {
    e.preventDefault()
    const code = normalizeDisplayCode(input)
    if (!isValidDisplayCode(code)) {
      setError('Enter the 6-character code shown on the POS screen.')
      return
    }
    navigate(`/customer-view/${code}`, { replace: true })
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg-base)',
      color: 'var(--text-primary)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      fontFamily: 'inherit',
    }}>
      <div style={{
        width: '100%',
        maxWidth: 420,
        padding: '32px 28px',
        background: 'var(--bg-surface)',
        borderRadius: 16,
        border: '1px solid var(--border-default)',
        boxShadow: 'var(--shadow-md)',
      }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🧾</div>
          <h1 style={{ margin: '0 0 8px', fontSize: 22, fontWeight: 700 }}>Customer display</h1>
          <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Enter the display code from the cashier POS to view your live bill.
          </p>
        </div>

        <form onSubmit={submit}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8 }}>
            Display code
          </label>
          <input
            className="form-input"
            value={input}
            onChange={(e) => {
              setInput(e.target.value.toUpperCase())
              setError('')
            }}
            placeholder="e.g. K7M3NP"
            autoComplete="off"
            autoFocus
            spellCheck={false}
            style={{
              width: '100%',
              textAlign: 'center',
              fontSize: 28,
              fontWeight: 700,
              letterSpacing: '0.2em',
              fontFamily: 'DM Mono, monospace',
              padding: '14px 12px',
              marginBottom: error ? 8 : 20,
            }}
          />
          {error && (
            <p style={{ margin: '0 0 16px', fontSize: 12.5, color: 'var(--red)' }}>{error}</p>
          )}
          <button type="submit" className="btn btn-primary" style={{ width: '100%', padding: '12px 16px' }}>
            Connect
          </button>
        </form>

        <p style={{ marginTop: 20, fontSize: 11.5, color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.5 }}>
          Each POS terminal has its own code. Ask the cashier if you do not see one on screen.
        </p>
      </div>
    </div>
  )
}

function CustomerDisplayLive({ roomId }) {
  const [display, setDisplay] = useState(EMPTY_POS_DISPLAY)
  const [organisation, setOrganisation] = useState(null)
  const { connected } = useDisplaySocket(roomId, 'viewer', setDisplay)

  useEffect(() => {
    settingsAPI.getOrganisation()
      .then((res) => {
        const data = res?.data ?? res
        if (data?.name) setOrganisation(data)
      })
      .catch(() => null)
  }, [])

  const { customer, branchName, cashierName, items, subtotal, tax, discount, total, taxMode } = display
  const code = normalizeDisplayCode(display.displayCode || roomId)

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg-base)',
      color: 'var(--text-primary)',
      padding: '32px 24px',
      fontFamily: 'inherit',
    }}>
      <header style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 28,
        paddingBottom: 16,
        borderBottom: '1px solid var(--border-default)',
      }}>
        <div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 4 }}>Your order</div>
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 700 }}>{organisation?.name || 'Sri Murugan Traders'}</h1>
          {branchName && (
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 6 }}>{branchName}</div>
          )}
          {cashierName && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Terminal: {cashierName}</div>
          )}
        </div>
        <div style={{
          fontSize: 12,
          padding: '6px 12px',
          borderRadius: 20,
          background: connected ? 'var(--green-bg)' : 'var(--red-bg)',
          color: connected ? 'var(--green)' : 'var(--red)',
          fontWeight: 600,
        }}>
          {connected ? 'Live' : 'Connecting…'}
        </div>
      </header>

      <section style={{
        marginBottom: 24,
        padding: '16px 18px',
        background: 'var(--bg-surface)',
        borderRadius: 12,
        border: '1px solid var(--border-default)',
      }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>Customer</div>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{customer?.name || 'Walk-in'}</div>
        {customer?.phone && (
          <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 4 }}>{customer.phone}</div>
        )}
      </section>

      <section style={{
        background: 'var(--bg-surface)',
        borderRadius: 12,
        border: '1px solid var(--border-default)',
        overflow: 'hidden',
      }}>
        <table className="data-table" style={{ margin: 0 }}>
          <thead>
            <tr>
              <th>Item</th>
              <th className="text-right">Qty</th>
              <th className="text-right">Rate</th>
              <th className="text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={4} style={{ textAlign: 'center', padding: 48, color: 'var(--text-muted)' }}>
                  Waiting for POS cart…
                </td>
              </tr>
            ) : (
              items.map((row, i) => (
                <tr key={`${row.name}-${i}`}>
                  <td style={{ fontWeight: 500, fontSize: 15 }}>{row.name || '—'}</td>
                  <td className="text-right mono">{row.qty}</td>
                  <td className="text-right mono">{fmt(row.price)}</td>
                  <td className="text-right mono" style={{ fontWeight: 600 }}>{fmt(row.subtotal)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      {items.length > 0 && (
        <section style={{
          marginTop: 20,
          padding: '18px 22px',
          background: 'var(--bg-raised)',
          borderRadius: 12,
          border: '1px solid var(--border-default)',
        }}>
          {taxMode === 'inclusive' && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
              Amounts include tax
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--text-muted)', marginBottom: 6 }}>
            <span>Taxable amount</span>
            <span className="mono">{fmt(subtotal)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--text-muted)', marginBottom: 6 }}>
            <span>Tax amount</span>
            <span className="mono">{fmt(tax)}</span>
          </div>
          {discount > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--green)', marginBottom: 6 }}>
              <span>Discount</span>
              <span className="mono">−{fmt(discount)}</span>
            </div>
          )}
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 14,
            paddingTop: 14,
            borderTop: '1px solid var(--border-default)',
          }}>
            <span style={{ fontSize: 16, fontWeight: 600 }}>Total</span>
            <span style={{ fontSize: 28, fontWeight: 700, fontFamily: 'DM Mono', color: 'var(--accent)' }}>
              {fmt(total)}
            </span>
          </div>
        </section>
      )}

      <p style={{ marginTop: 20, fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>
        Session code: <span className="mono" style={{ fontWeight: 600 }}>{code}</span>
      </p>
    </div>
  )
}

/** Read-only customer screen — mirrors the live /pos cart via WebSocket. */
export default function CustomerDisplayPage() {
  const { roomId } = useParams()
  const code = normalizeDisplayCode(roomId)

  if (!isValidDisplayCode(code)) {
    return <DisplayCodeEntry />
  }

  return <CustomerDisplayLive roomId={code} />
}
