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

export function getColumnDefinitions(config) {
  const cols = [
    { key: 'no', label: 'No.', width: '5%', align: 'left' },
    { key: 'description', label: 'Description', width: '34%', align: 'left' },
  ]
  if (config.showHsn) cols.push({ key: 'hsn', label: 'HSN', width: '8%', align: 'left' })
  if (config.showAttr) cols.push({ key: 'attr', label: 'Attribute', width: '7%', align: 'left' })
  if (config.showSize) cols.push({ key: 'packing', label: 'Packing', width: '7%', align: 'left' })
  cols.push({ key: 'origin', label: 'Origin', width: '7%', align: 'left' })
  cols.push({ key: 'units', label: 'Units', width: '7%', align: 'left' })
  cols.push({ key: 'qty', label: 'Qty', width: '5%', align: 'right' })
  cols.push({ key: 'rate', label: 'Rate', width: '12%', align: 'right' })
  if (config.showDisc) cols.push({ key: 'disc', label: 'Disc %', width: '6%', align: 'right' })
  cols.push({ key: 'gst', label: 'GST', width: '8%', align: 'right' })
  cols.push({ key: 'amount', label: 'Amount', width: '9%', align: 'right' })
  return cols
}

export function getColumnStructure(config) {
  return getColumnDefinitions(config).map((col) => col.width).join(' ')
}

export function getColumnHeaders(config) {
  return getColumnDefinitions(config).map((col) => col.label)
}

export function getColumnKeys(config) {
  return getColumnDefinitions(config).map((col) => col.key)
}

export function getItemCell(item, field, config) {
  if (field === 'no') return null
  if (field === 'description') return item.name
  if (field === 'hsn' && config.showHsn) return item.hsnCode || item.hsn_code || ''
  if (field === 'attr' && config.showAttr) return item.attribute || item.attr || ''
  if (field === 'packing' && config.showSize) return item.size || item.package || item.packing || ''
  if (field === 'origin') return item.origin || item.country || item.manufacturer || ''
  if (field === 'units') return item.units || item.unit || ''
  if (field === 'disc' && config.showDisc) return `${item.discount ?? item.discPercent ?? 0}%`
  if (field === 'qty') return item.qty || item.quantity || 0
  if (field === 'rate') return item.price ?? item.rate
  if (field === 'gst') {
    const qty = Number(item.qty || item.quantity || 0)
    const rate = Number(item.price ?? item.rate ?? 0)
    const discountPct = Number(item.discount ?? item.discPercent ?? 0)
    const amount = Number(item.lineTotal ?? item.total ?? qty * rate)
    const taxable = discountPct ? amount * (1 - discountPct / 100) : amount
    const taxRate = Number(item.taxRate ?? item.tax_rate ?? 0)
    return Math.round((taxable * taxRate) / 100 * 100) / 100
  }
  if (field === 'amount') return item.lineTotal || item.total || (item.qty * item.price)
  return ''
}
