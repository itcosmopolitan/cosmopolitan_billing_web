import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import toast from 'react-hot-toast'
import { vendorsAPI } from '@/api'
import { Modal, FormGroup, FormRow, AutocompleteDropdown } from '@/components/ui'
import { VENDOR_PAYMENT_TERMS_OPTIONS } from '@/utils/dropdownOptions'

const emptyForm = () => ({
  name: '',
  contact_person: '',
  phone: '',
  email: '',
  address: '',
  gstin: '',
  payment_terms: '30 days',
})

function formFromVendor(vendor) {
  return {
    name: vendor.name || '',
    contact_person: vendor.contact_person || '',
    phone: vendor.phone || '',
    email: vendor.email || '',
    address: vendor.address || '',
    gstin: vendor.gstin || '',
    payment_terms: vendor.payment_terms || '30 days',
  }
}

/**
 * Add / edit vendor — same dialog as the Vendors page.
 * Pass `vendor` to edit; omit it to create.
 */
export default function VendorFormModal({
  open,
  onClose,
  onSaved,
  vendor = null,
  zIndex,
}) {
  const isEdit = Boolean(vendor?.id)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const pf = (k, v) => setForm((f) => ({ ...f, [k]: v }))

  useEffect(() => {
    if (!open) return
    setForm(vendor?.id ? formFromVendor(vendor) : emptyForm())
  }, [open, vendor])

  const save = async () => {
    if (saving) return
    if (!form.name?.trim()) { toast.error('Vendor name required'); return }
    setSaving(true)
    try {
      const payload = {
        name: form.name.trim(),
        contact_person: form.contact_person?.trim() || undefined,
        phone: form.phone?.trim() || undefined,
        email: form.email?.trim() || undefined,
        address: form.address?.trim() || undefined,
        gstin: form.gstin?.trim() || undefined,
        payment_terms: form.payment_terms,
      }
      let record
      if (isEdit) {
        await vendorsAPI.update(vendor.id, payload)
        toast.success('Vendor updated')
        record = { ...vendor, ...payload, id: vendor.id }
      } else {
        record = await vendorsAPI.create(payload)
        toast.success('Vendor added')
        if (!record?.id) record = { ...record, id: record?.id, name: form.name.trim() }
      }
      onSaved?.(record)
      onClose?.()
    } catch (err) {
      console.error(isEdit ? 'Failed to update vendor:' : 'Failed to save vendor:', err)
      toast.error(err?.response?.data?.detail || err?.message || (isEdit ? 'Failed to update vendor' : 'Failed to save vendor'))
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  const node = (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit Vendor' : 'Add Vendor'}
      icon={isEdit ? '✏️' : '🏭'}
      size="md"
      busy={saving}
      zIndex={zIndex}
      footer={(
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Save Vendor'}
          </button>
        </>
      )}
    >
      <FormRow>
        <FormGroup label="Company / Vendor Name" required>
          <input className="form-input" value={form.name} onChange={(e) => pf('name', e.target.value)} />
        </FormGroup>
        <FormGroup label="Contact Person">
          <input className="form-input" value={form.contact_person} onChange={(e) => pf('contact_person', e.target.value)} />
        </FormGroup>
      </FormRow>
      <FormRow>
        <FormGroup label="Phone">
          <input className="form-input" value={form.phone} onChange={(e) => pf('phone', e.target.value)} />
        </FormGroup>
        <FormGroup label="Email">
          <input className="form-input" type="email" value={form.email} onChange={(e) => pf('email', e.target.value)} />
        </FormGroup>
      </FormRow>
      <FormGroup label="Address">
        <textarea className="form-input" style={{ height: 64 }} value={form.address} onChange={(e) => pf('address', e.target.value)} />
      </FormGroup>
      <FormRow>
        <FormGroup label="GST Reg No">
          <input className="form-input" value={form.gstin} onChange={(e) => pf('gstin', e.target.value)} placeholder="GST registration number" />
        </FormGroup>
        <FormGroup label="Payment Terms">
          <AutocompleteDropdown
            value={form.payment_terms}
            onChange={(v) => pf('payment_terms', v)}
            options={VENDOR_PAYMENT_TERMS_OPTIONS}
            isSearchFieldRequired={false}
          />
        </FormGroup>
      </FormRow>
    </Modal>
  )

  return createPortal(node, document.body)
}
