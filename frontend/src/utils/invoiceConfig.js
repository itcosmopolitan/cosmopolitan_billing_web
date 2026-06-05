/**
 * Invoice template config — persisted via GET/PUT /settings/invoice-template.
 */
import { useEffect, useState } from 'react'
import { settingsAPI } from '@/api'

export const INVOICE_CONFIG_CHANGED_EVENT = 'invoice-template-config-changed'

export const DEFAULT_INVOICE_CONFIG = {
  headerStyle: 'full',
  showAttr: true,
  showSize: true,
  showDisc: true,
  showHsn: false,
  taxMode: 'total',
  showCustomer: true,
  showPayment: true,
  showPrintedDate: true,
  showStore: true,
  showCashier: true,
  footerMsg: 'Thank you for shopping with us! Champa brothers',
  footerNote: 'Goods once sold will not be taken back',
}

function normalizeInvoiceConfig(config) {
  return { ...DEFAULT_INVOICE_CONFIG, ...(config || {}) }
}

export function apiToConfig(data) {
  if (!data) return DEFAULT_INVOICE_CONFIG
  return normalizeInvoiceConfig({
    headerStyle: data.header_style,
    showAttr: data.show_attr,
    showSize: data.show_size,
    showDisc: data.show_disc,
    showHsn: data.show_hsn,
    taxMode: data.tax_mode,
    showCustomer: data.show_customer,
    showPayment: data.show_payment,
    showPrintedDate: data.show_printed_date,
    showStore: data.show_store,
    showCashier: data.show_cashier,
    footerMsg: data.footer_msg,
    footerNote: data.footer_note,
  })
}

export function configToApi(config) {
  const c = normalizeInvoiceConfig(config)
  return {
    header_style: c.headerStyle,
    show_attr: c.showAttr,
    show_size: c.showSize,
    show_disc: c.showDisc,
    show_hsn: c.showHsn,
    tax_mode: c.taxMode,
    show_customer: c.showCustomer,
    show_payment: c.showPayment,
    show_printed_date: c.showPrintedDate,
    show_store: c.showStore,
    show_cashier: c.showCashier,
    footer_msg: c.footerMsg,
    footer_note: c.footerNote,
  }
}

export function notifyInvoiceConfigChanged(config) {
  window.dispatchEvent(new CustomEvent(INVOICE_CONFIG_CHANGED_EVENT, {
    detail: normalizeInvoiceConfig(config),
  }))
}

export function useInvoiceConfig() {
  const [config, setConfig] = useState(DEFAULT_INVOICE_CONFIG)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const data = await settingsAPI.getInvoiceTemplate()
        if (!cancelled) setConfig(apiToConfig(data))
      } catch (e) {
        if (e?.code !== 'ERR_CANCELED' && !cancelled) console.error(e)
      }
    })()

    const onConfigChanged = (event) => setConfig(normalizeInvoiceConfig(event.detail))
    window.addEventListener(INVOICE_CONFIG_CHANGED_EVENT, onConfigChanged)
    return () => {
      cancelled = true
      window.removeEventListener(INVOICE_CONFIG_CHANGED_EVENT, onConfigChanged)
    }
  }, [])

  return config
}

export function getColumnStructure(config) {
  const cols = ['2.5fr']
  if (config.showHsn) cols.push('0.9fr')
  if (config.showAttr) cols.push('1fr')
  if (config.showSize) cols.push('0.8fr')
  if (config.showDisc) cols.push('0.7fr')
  cols.push('0.7fr')
  cols.push('1.2fr')
  cols.push('1.2fr')
  return cols.join(' ')
}

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
