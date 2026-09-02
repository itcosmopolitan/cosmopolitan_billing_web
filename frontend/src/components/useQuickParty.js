import { createElement, useMemo, useState } from 'react'
import { useCan } from '@/auth/permissions'
import CustomerFormModal from '@/pages/customers/CustomerFormModal'
import VendorFormModal from '@/pages/vendors/VendorFormModal'

export function useQuickCustomer({ onCreated, defaultBranchId, enabled = true } = {}) {
  const can = useCan()
  const [open, setOpen] = useState(false)
  const allow = enabled && can('customers.create', 'pos.use')

  const footerAction = useMemo(
    () => (allow ? { label: '+ Add customer', onClick: () => setOpen(true) } : null),
    [allow],
  )

  const modal = createElement(CustomerFormModal, {
    open,
    onClose: () => setOpen(false),
    defaultBranchId,
    zIndex: 1050,
    onSaved: (customer) => {
      setOpen(false)
      onCreated?.(customer)
    },
  })

  return { footerAction, modal }
}

export function useQuickVendor({ onCreated, enabled = true } = {}) {
  const can = useCan()
  const [open, setOpen] = useState(false)
  const allow = enabled && can('vendors.create')

  const footerAction = useMemo(
    () => (allow ? { label: '+ Add vendor', onClick: () => setOpen(true) } : null),
    [allow],
  )

  const modal = createElement(VendorFormModal, {
    open,
    onClose: () => setOpen(false),
    zIndex: 1050,
    onSaved: (vendor) => {
      setOpen(false)
      onCreated?.(vendor)
    },
  })

  return { footerAction, modal }
}
