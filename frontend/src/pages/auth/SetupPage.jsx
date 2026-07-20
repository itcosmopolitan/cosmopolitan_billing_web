import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import '@/styles/login.css'
import BrandLogo from '@/components/BrandLogo'
import { setupAPI } from '@/api'

const initialForm = {
  organizationName: '',
  organizationGstin: '',
  organizationPan: '',
  organizationAddress: '',
  organizationPhone: '',
  organizationEmail: '',
  organizationWebsite: '',
  branchName: '',
  branchPhone: '',
  branchEmail: '',
  branchAddress: '',
  adminName: '',
  adminEmail: '',
}

export default function SetupPage() {
  const navigate = useNavigate()
  const [form, setForm] = useState(initialForm)
  const [step, setStep] = useState(1) // 1: Organization, 2: Branch + User
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const status = await setupAPI.status().catch(() => ({ required: false }))
        if (!cancelled && !status?.required) {
          navigate('/login', { replace: true })
        }
      } finally {
        if (!cancelled) setChecking(false)
      }
    })()
    return () => { cancelled = true }
  }, [navigate])

  const canSubmit = useMemo(() => {
    if (step === 1) {
      return Boolean(form.organizationName.trim())
    }
    if (step === 2) {
      return Boolean(
        form.branchName.trim() &&
        form.adminName.trim() &&
        form.adminEmail.trim(),
      )
    }
    return false
  }, [form, step])

  const canGoNext = useMemo(() => {
    if (step === 1) {
      return Boolean(form.organizationName.trim())
    }
    return false
  }, [form, step])

  const handleChange = (event) => {
    const { name, value } = event.target
    setForm((prev) => ({ ...prev, [name]: value }))
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (step === 1) {
      if (canGoNext) {
        setStep(step + 1)
      }
      return
    }
    if (step === 2 && (!canSubmit || loading)) return

    setLoading(true)
    try {
      await setupAPI.initialize({
        organizationName: form.organizationName.trim(),
        organizationGstin: form.organizationGstin.trim(),
        organizationPan: form.organizationPan.trim(),
        organizationAddress: form.organizationAddress.trim(),
        organizationPhone: form.organizationPhone.trim(),
        organizationEmail: form.organizationEmail.trim(),
        organizationWebsite: form.organizationWebsite.trim(),
        branchName: form.branchName.trim(),
        branchPhone: form.branchPhone.trim(),
        branchEmail: form.branchEmail.trim(),
        branchAddress: form.branchAddress.trim(),
        adminName: form.adminName.trim(),
        adminEmail: form.adminEmail.trim(),
      })
      toast.success('Setup complete. A temporary password has been sent to the super admin email.')
      navigate('/login', { replace: true })
    } catch (error) {
      console.error(error)
      toast.error(error.response?.data?.detail || 'Setup failed')
    } finally {
      setLoading(false)
    }
  }

  const handlePrevious = () => {
    if (step > 1) {
      setStep(step - 1)
    }
  }

  if (checking) {
    return (
      <div className="page-wrapper login-shell">
        <div className="login-card" style={{ maxWidth: 780, padding: 24 }}>
          <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>Preparing your first-run setup…</div>
        </div>
      </div>
    )
  }

  return (
    <div className="page-wrapper login-shell" style={{ padding: 16, alignItems: 'flex-start' }}>
      <div className="login-card" style={{ maxWidth: 1240, width: '100%', padding: 20, margin: '8px auto' }}>
        <section className="login-panel login-panel--form" style={{ width: '100%' }}>
          <div className="login-panel-inner" style={{ padding: 8 }}>
            <div className="login-brand-row" style={{ marginBottom: 24, paddingBottom: 20, borderBottom: '1px solid var(--border-default)', textAlign: 'center' }}>
              <BrandLogo className="login-logo-img" height={48} maxWidth={300} />
            </div>
            {/* Progress Bar */}
            <div className="login-eyebrow">First run setup</div>
            <div className="login-heading" style={{ marginBottom: 8 }}>
              <h1 style={{ margin: '4px 0' }}>
                {step === 1 && 'Organization details'}
                {step === 2 && 'Branch & Super admin'}
              </h1>
              <p style={{ margin: '4px 0 0 0', fontSize: 13 }}>
                
              </p>
            </div>

            <form onSubmit={handleSubmit} className="login-form" style={{ display: 'grid', gap: 20 }}>
              {/* Step Indicator */}
              {/* <div style={{ display: 'flex', justifyContent: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                <div style={{
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: step >= 1 ? 'var(--brand-primary)' : 'var(--bg-secondary)',
                  color: step >= 1 ? 'white' : 'var(--text-muted)',
                  fontWeight: 600,
                  opacity: step === 2 ? 0 : 1,
                  transition: 'opacity 0.3s ease',
                }}>1</div>
                <div style={{
                  flex: 1,
                  height: 2,
                  background: 'var(--brand-primary)',
                  alignSelf: 'center',
                }} />
                <div style={{
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: step >= 2 ? 'var(--brand-primary)' : 'var(--bg-secondary)',
                  color: step >= 2 ? 'white' : 'var(--text-muted)',
                  fontWeight: 600,
                  opacity: step === 1 ? 0 : 1,
                  transition: 'opacity 0.3s ease',
                }}>2</div>
              </div> */}

              {/* Step 1: Organization Details */}
              {step === 1 && (
                <section style={{ border: '1px solid var(--border-default)', borderRadius: 16, padding: 20, background: 'var(--bg-surface)', minHeight: 420 }}>
                  <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, color: 'var(--text-primary)' }}>Organization Details</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 0.8fr', gap: 12 }}>
                    <div className="form-group">
                      <label className="form-label">Organization name *</label>
                      <input className="form-input" name="organizationName" value={form.organizationName} onChange={handleChange} placeholder="Cosmopolitan Billing" required />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Email</label>
                      <input className="form-input" type="email" name="organizationEmail" value={form.organizationEmail} onChange={handleChange} placeholder="accounts@company.com" />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Website</label>
                      <input className="form-input" name="organizationWebsite" value={form.organizationWebsite} onChange={handleChange} placeholder="https://example.com" />
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12, marginTop: 12 }}>
                    <div className="form-group">
                      <label className="form-label">GSTIN</label>
                      <input className="form-input" name="organizationGstin" value={form.organizationGstin} onChange={handleChange} placeholder="29ABCDE1234F1Z2" />
                    </div>
                    <div className="form-group">
                      <label className="form-label">PAN</label>
                      <input className="form-input" name="organizationPan" value={form.organizationPan} onChange={handleChange} placeholder="ABCDE1234F" />
                    </div>
                    <div className="form-group">
                      <label className="form-label">Phone</label>
                      <input className="form-input" name="organizationPhone" value={form.organizationPhone} onChange={handleChange} placeholder="+91 98765 43210" />
                    </div>
                  </div>

                  <div className="form-group" style={{ marginTop: 12 }}>
                    <label className="form-label">Address</label>
                    <textarea className="form-input" name="organizationAddress" value={form.organizationAddress} onChange={handleChange} rows={2} placeholder="Street, city, state, pincode" />
                  </div>
                </section>
              )}

              {/* Step 2: Branch Details + User Details */}
              {step === 2 && (
                <div style={{ display: 'grid', gap: 20, minHeight: 420 }}>
                  <section style={{ border: '1px solid var(--border-default)', borderRadius: 16, padding: 20, background: 'var(--bg-surface)' }}>
                    <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, color: 'var(--text-primary)' }}>Branch Details</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12, marginTop: 12 }}>
                      <div className="form-group">
                        <label className="form-label">Branch name *</label>
                        <input className="form-input" name="branchName" value={form.branchName} onChange={handleChange} placeholder="Main Branch" required />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Branch phone</label>
                        <input className="form-input" name="branchPhone" value={form.branchPhone} onChange={handleChange} placeholder="+91 98765 43210" />
                      </div>
                    </div>

                    <div className="form-group" style={{ marginTop: 12 }}>
                      <label className="form-label">Branch address</label>
                      <input className="form-input" name="branchAddress" value={form.branchAddress} onChange={handleChange} placeholder="Street, city" />
                    </div>
                  </section>

                  <section style={{ border: '1px solid var(--border-default)', borderRadius: 16, padding: 20, background: 'var(--bg-surface)' }}>
                    <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 16, color: 'var(--text-primary)' }}>Super Admin Details</div>
                    <p style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 14 }}>
                      A temporary password will be sent to the super admin email for secure account setup.
                    </p>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
                      <div className="form-group">
                        <label className="form-label">Super admin name *</label>
                        <input className="form-input" name="adminName" value={form.adminName} onChange={handleChange} placeholder="Suresh Kumar" required />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Super admin email *</label>
                        <input className="form-input" type="email" name="adminEmail" value={form.adminEmail} onChange={handleChange} placeholder="admin@company.com" required />
                      </div>
                    </div>
                  </section>
                </div>
              )}

              {/* Navigation Buttons */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                {step > 1 && (
                  <button
                    type="button"
                    onClick={handlePrevious}
                    disabled={loading}
                    style={{
                      width: 48,
                      height: 48,
                      borderRadius: '50%',
                      background: loading ? '#ccc' : '#16a34a',
                      color: 'white',
                      border: 'none',
                      fontSize: 24,
                      fontWeight: 600,
                      cursor: loading ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      transition: 'background 0.2s',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                    }}
                  >
                    &lt;
                  </button>
                )}
                <div style={{ flex: 1 }} />
                {step < 2 ? (
                  <button
                    type="submit"
                    disabled={loading || !canSubmit}
                    style={{
                      width: 48,
                      height: 48,
                      borderRadius: '50%',
                      background: loading || !canSubmit ? '#ccc' : '#16a34a',
                      color: 'white',
                      border: 'none',
                      fontSize: 24,
                      fontWeight: 600,
                      cursor: loading || !canSubmit ? 'not-allowed' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      transition: 'background 0.2s',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                    }}
                  >
                    &gt;
                  </button>
                ) : (
                  <button className="btn btn-primary" type="submit" disabled={loading || !canSubmit} style={{ minWidth: 160 }}>
                    {loading ? 'Completing setup…' : 'Complete Setup'}
                  </button>
                )}
              </div>
            </form>
          </div>
        </section>
      </div>
    </div>
  )
}
