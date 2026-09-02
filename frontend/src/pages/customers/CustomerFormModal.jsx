import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import toast from 'react-hot-toast'
import { customersAPI, AUTOCOMPLETE_BRANCH_URL, AUTOCOMPLETE_BRANCH_USERS_URL } from '@/api'
import { useAppStore } from '@/store'
import { Modal, FormGroup, FormRow, AutocompleteDropdown } from '@/components/ui'
import { CUSTOMER_TYPE_OPTIONS, CUSTOMER_CLASSIFICATION_OPTIONS } from '@/utils/dropdownOptions'
import { decomposeAddress } from '@/utils/address'

const emptyForm = (branchId) => ({
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
  branch_id: branchId || '',
  credit_limit: '0',
  customer_type: 'retail',
  classification: 'external',
  key_account_manager: '',
  key_account_manager_name: '',
  credit_terms: '',
})

function formFromCustomer(customer) {
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
    structured.street1 || structured.street2 || structured.street3
    || structured.city || structured.stateProvince || structured.country || structured.postalCode,
  )
  const addressParts = hasStructured ? structured : decomposeAddress(customer.address)
  return {
    ...emptyForm(),
    name: customer.name || '',
    phone: customer.phone || '',
    email: customer.email || '',
    gst_in: customer.gst_in || customer.gstin || '',
    ...addressParts,
    branch_id: customer.branch_id || '',
    credit_limit: customer.credit_limit != null ? String(customer.credit_limit) : '0',
    customer_type: customer.customer_type || customer.type || 'retail',
    classification: customer.classification === 'internal' ? 'internal' : 'external',
    key_account_manager: customer.keyAccountManagerId || customer.key_account_manager || '',
    key_account_manager_name: customer.keyAccountManager || customer.key_account_manager_name || '',
    credit_terms: customer.credit_terms || customer.creditTerms || '',
  }
}

/**
 * Add / edit customer — same dialog as the Customers page.
 * Pass `customer` to edit; omit it to create.
 */
export default function CustomerFormModal({
  open,
  onClose,
  onSaved,
  customer = null,
  defaultBranchId,
  zIndex,
}) {
  const branches = useAppStore((s) => s.branches)
  const activeBranch = useAppStore((s) => s.activeBranch)
  const isEdit = Boolean(customer?.id)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState(() => emptyForm(defaultBranchId || activeBranch?.id || branches[0]?.id || ''))
  const pf = (k, v) => setForm((f) => ({ ...f, [k]: v }))

  useEffect(() => {
    if (!open) return
    if (customer?.id) {
      setForm(formFromCustomer(customer))
      return
    }
    setForm(emptyForm(defaultBranchId || activeBranch?.id || branches[0]?.id || ''))
  }, [open, customer, defaultBranchId, activeBranch?.id, branches])

  const save = async () => {
    if (saving) return
    if (!form.name?.trim()) { toast.error('Customer name required'); return }
    if (!form.branch_id) { toast.error('Select a branch'); return }
    if (!branches.find((b) => b.id === form.branch_id)) { toast.error('Select a valid branch'); return }
    if (!form.street1?.trim()) { toast.error('Street 1 is required'); return }
    if (!form.city?.trim()) { toast.error('City is required'); return }
    if (!form.country?.trim()) { toast.error('Country is required'); return }
    if (form.email?.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      toast.error('Enter a valid email address')
      return
    }

    const token = localStorage.getItem('retailos_token')
    if (!token) { toast.error('Not authenticated'); return }

    const payload = {
      name: form.name.trim(),
      phone: form.phone?.trim() || undefined,
      email: form.email?.trim() || undefined,
      address: '',
      gst_in: form.gst_in?.trim() || undefined,
      branch_id: form.branch_id,
      credit_limit: form.customer_type === 'retail' ? 0 : (Number(form.credit_limit) || 0),
      customer_type: form.customer_type,
      classification: form.classification === 'internal' ? 'internal' : 'external',
      key_account_manager: form.key_account_manager?.trim() || null,
      credit_terms: form.customer_type === 'retail' ? null : (form.credit_terms === '' ? null : Number(form.credit_terms)),
      street1: form.street1?.trim(),
      street2: form.street2?.trim() || undefined,
      street3: form.street3?.trim() || undefined,
      city: form.city?.trim(),
      state_province: form.stateProvince?.trim() || undefined,
      country: form.country?.trim(),
      postal_code: form.postalCode?.trim() || undefined,
    }

    setSaving(true)
    try {
      let record
      if (isEdit) {
        await customersAPI.update(customer.id, payload)
        toast.success('Customer updated successfully')
        try {
          record = await customersAPI.get(customer.id)
        } catch {
          record = { ...customer, ...payload, id: customer.id }
        }
      } else {
        const created = await customersAPI.create(payload)
        toast.success('Customer added successfully')
        const id = created?.id
        record = {
          id,
          name: form.name.trim(),
          phone: form.phone?.trim() || '',
          email: form.email?.trim() || '',
          customer_type: form.customer_type,
          type: form.customer_type,
          classification: form.classification === 'internal' ? 'internal' : 'external',
          credit_balance: 0,
          branch_id: form.branch_id,
        }
        if (id) {
          try {
            record = await customersAPI.get(id)
          } catch {
            /* use the local snapshot */
          }
        }
      }
      onSaved?.(record)
      onClose?.()
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

  if (!open) return null

  const node = (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit Customer' : 'Add Customer'}
      icon="👤"
      size="md"
      busy={saving}
      zIndex={zIndex}
      footer={(
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Save Customer'}
          </button>
        </>
      )}
    >
      <FormRow>
        <FormGroup label="Name" required>
          <input className="form-input" value={form.name} onChange={(e) => pf('name', e.target.value)} placeholder="Full name or company" />
        </FormGroup>
        <FormGroup label="Phone">
          <input className="form-input" value={form.phone} onChange={(e) => pf('phone', e.target.value)} placeholder="10-digit mobile" />
        </FormGroup>
      </FormRow>
      <FormRow>
        <FormGroup label="Email">
          <input className="form-input" type="email" value={form.email} onChange={(e) => pf('email', e.target.value)} />
        </FormGroup>
        <FormGroup label="GST Reg No">
          <input className="form-input" value={form.gst_in} onChange={(e) => pf('gst_in', e.target.value)} placeholder="For business customers" />
        </FormGroup>
      </FormRow>
      <FormGroup label="Street 1" required>
        <input className="form-input" maxLength={30} value={form.street1} onChange={(e) => pf('street1', e.target.value)} placeholder="Street address line 1" />
      </FormGroup>
      <FormRow>
        <FormGroup label="Street 2">
          <input className="form-input" maxLength={30} value={form.street2} onChange={(e) => pf('street2', e.target.value)} placeholder="Street address line 2" />
        </FormGroup>
        <FormGroup label="Street 3">
          <input className="form-input" maxLength={30} value={form.street3} onChange={(e) => pf('street3', e.target.value)} placeholder="Street address line 3" />
        </FormGroup>
      </FormRow>
      <FormRow>
        <FormGroup label="City" required>
          <input className="form-input" value={form.city} onChange={(e) => pf('city', e.target.value)} placeholder="City" />
        </FormGroup>
        <FormGroup label="State / Province">
          <input className="form-input" value={form.stateProvince} onChange={(e) => pf('stateProvince', e.target.value)} placeholder="State or province" />
        </FormGroup>
      </FormRow>
      <FormRow>
        <FormGroup label="Country" required>
          <input className="form-input" value={form.country} onChange={(e) => pf('country', e.target.value)} placeholder="Country" />
        </FormGroup>
        <FormGroup label="Postal Code / Zipcode">
          <input className="form-input" value={form.postalCode} onChange={(e) => pf('postalCode', e.target.value)} placeholder="Postal code or zipcode" />
        </FormGroup>
      </FormRow>
      <FormRow>
        <FormGroup label="Primary Branch" required>
          <AutocompleteDropdown
            value={form.branch_id}
            onChange={(v) => pf('branch_id', v)}
            fetchUrl={AUTOCOMPLETE_BRANCH_URL}
            fetchParams={{ retail_only: true }}
            prependOptions={[{ id: '', label: 'Select branch…' }]}
            isSearchFieldRequired={false}
            selectedLabel={form.branch_id && branches.find((b) => b.id === form.branch_id)?.name || undefined}
            placeholder="Select branch…"
          />
        </FormGroup>
        <FormGroup label="Customer type" required>
          <AutocompleteDropdown
            value={form.classification}
            onChange={(v) => pf('classification', v || 'external')}
            options={CUSTOMER_CLASSIFICATION_OPTIONS}
            isSearchFieldRequired={false}
          />
          {form.classification === 'internal' && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
              GST is subtracted from item amounts (GST 0% billed).
            </div>
          )}
        </FormGroup>
      </FormRow>
      <FormRow>
        <FormGroup label="Pricing category" required>
          <AutocompleteDropdown
            value={form.customer_type}
            onChange={(v) => {
              pf('customer_type', v)
              if (v === 'retail') pf('credit_limit', '0')
            }}
            options={CUSTOMER_TYPE_OPTIONS}
            isSearchFieldRequired={false}
          />
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
        {form.customer_type !== 'retail' && (
          <FormGroup label="Account limit (MVR)">
            <input className="form-input" type="number" value={form.credit_limit} onChange={(e) => pf('credit_limit', e.target.value)} />
          </FormGroup>
        )}
      </FormRow>
      {form.customer_type !== 'retail' && (
        <FormGroup label="Credit terms">
          <input
            className="form-input"
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            value={form.credit_terms}
            onChange={(e) => pf('credit_terms', e.target.value.replace(/\D/g, ''))}
            placeholder="Numbers of days"
          />
        </FormGroup>
      )}
    </Modal>
  )

  return createPortal(node, document.body)
}
