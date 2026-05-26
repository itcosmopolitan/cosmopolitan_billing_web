/**
 * Invoice Template Configuration Utilities
 * Manages saved template settings for invoices and receipts
 */
import { useEffect, useState } from 'react'

export const INVOICE_CONFIG_STORAGE_KEY = 'invoiceTemplateConfig'
export const INVOICE_CONFIG_CHANGED_EVENT = 'invoice-template-config-changed'

export const DEFAULT_INVOICE_CONFIG = {
  headerStyle: 'full',       // 'full' | 'nameonly' | 'logo'
  showAttr: true,
  showSize: true,
  showDisc: true,
  showHsn: false,
  taxMode: 'total',         // 'total' | 'itemized'
  showCustomer: true,
  showPayment: true,
  showPrintedDate: true,
  showStore: true,
  showCashier: true,
  footerMsg: 'Thank you for shopping with us! Champa brothers',
  footerNote: 'Goods once sold will not be taken back'
}

function normalizeInvoiceConfig(config) {
  return { ...DEFAULT_INVOICE_CONFIG, ...(config || {}) }
}

export function getInvoiceConfig() {
  try {
    const saved = localStorage.getItem(INVOICE_CONFIG_STORAGE_KEY)
    return saved ? normalizeInvoiceConfig(JSON.parse(saved)) : DEFAULT_INVOICE_CONFIG
  } catch (e) {
    console.error('Failed to load invoice config:', e)
    return DEFAULT_INVOICE_CONFIG
  }
}

export function saveInvoiceConfig(config) {
  try {
    const next = normalizeInvoiceConfig(config)
    localStorage.setItem(INVOICE_CONFIG_STORAGE_KEY, JSON.stringify(next))
    window.dispatchEvent(new CustomEvent(INVOICE_CONFIG_CHANGED_EVENT, { detail: next }))
    return true
  } catch (e) {
    console.error('Failed to save invoice config:', e)
    return false
  }
}

export function useInvoiceConfig() {
  const [config, setConfig] = useState(() => getInvoiceConfig())

  useEffect(() => {
    const syncConfig = () => setConfig(getInvoiceConfig())
    const onConfigChanged = (event) => setConfig(normalizeInvoiceConfig(event.detail))

    window.addEventListener('storage', syncConfig)
    window.addEventListener(INVOICE_CONFIG_CHANGED_EVENT, onConfigChanged)
    return () => {
      window.removeEventListener('storage', syncConfig)
      window.removeEventListener(INVOICE_CONFIG_CHANGED_EVENT, onConfigChanged)
    }
  }, [])

  return config
}

/**
 * Generate column grid structure based on config
 */
export function getColumnStructure(config) {
  const cols = ['2.5fr'] // Item name
  if (config.showHsn) cols.push('0.9fr')
  if (config.showAttr) cols.push('1fr')
  if (config.showSize) cols.push('0.8fr')
  if (config.showDisc) cols.push('0.7fr')
  cols.push('0.7fr') // Qty
  cols.push('1.2fr') // Price
  cols.push('1.2fr') // Total
  return cols.join(' ')
}

/**
 * Get header names based on config
 */
export function getColumnHeaders(config) {
  const headers = ['Item Name']
  if (config.showHsn) headers.push('HSN')
  if (config.showAttr) headers.push('Attribute')
  if (config.showSize) headers.push('Size')
  if (config.showDisc) headers.push('Disc %')
  headers.push('Qty')
  headers.push('Price')
  headers.push('Total')
  return headers
}

/**
 * Get item cell value based on config and field
 */
export function getItemCell(item, field, config) {
  if (field === 'name') return item.name
  if (field === 'hsn' && config.showHsn) return item.hsnCode || item.hsn_code || ''
  if (field === 'attr' && config.showAttr) return item.attribute || item.attr || ''
  if (field === 'size' && config.showSize) return item.size || item.package || ''
  if (field === 'disc' && config.showDisc) return `${item.discount ?? item.discPercent ?? 0}%`
  if (field === 'qty') return item.qty || 0
  if (field === 'price') return item.price
  if (field === 'total') return item.lineTotal || item.total || (item.qty * item.price)
  return ''
}
