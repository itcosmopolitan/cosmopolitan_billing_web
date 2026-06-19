import { format, formatDistanceToNow, parseISO } from 'date-fns'

// ─── Currency formatting ──────────────────────────────────────────────────────
export const fmt = (amount, decimals = 0) => {
  if (amount === null || amount === undefined) return '—'
  return '₹' + Number(amount).toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

export const fmtNum = (n) => Number(n).toLocaleString('en-IN')

// ─── Date formatting ──────────────────────────────────────────────────────────
export const fmtDate = (d) => {
  if (!d) return '—'
  try { return format(typeof d === 'string' ? parseISO(d) : d, 'dd MMM yyyy') }
  catch { return d }
}

export const fmtDateShort = (d) => {
  if (!d) return '—'
  try { return format(typeof d === 'string' ? parseISO(d) : d, 'dd MMM') }
  catch { return d }
}

export const fmtDateTime = (d) => {
  if (!d) return '—'
  try { return format(typeof d === 'string' ? parseISO(d) : d, 'dd MMM yyyy, h:mm a') }
  catch { return d }
}

export const fmtRelative = (d) => {
  if (!d) return '—'
  try { return formatDistanceToNow(typeof d === 'string' ? parseISO(d) : d, { addSuffix: true }) }
  catch { return d }
}

// ─── Status ───────────────────────────────────────────────────────────────────
export const statusChip = (status) => {
  const map = {
    paid:     'chip-paid',
    active:   'chip-active',
    pending:  'chip-pending',
    overdue:  'chip-overdue',
    draft:    'chip-draft',
    partial:  'chip-partial',
    transit:  'chip-transit',
    received: 'chip-paid',
    low:      'chip-low',
    out:      'chip-out',
    cancelled:'chip-out',
  }
  return map[status] || 'chip-draft'
}

export const statusLabel = (status) => {
  const map = {
    paid: 'Paid', active: 'Active', pending: 'Pending', overdue: 'Overdue',
    draft: 'Draft', partial: 'Partial', transit: 'In Transit', received: 'Received',
    low: 'Low Stock', out: 'Out of Stock', cancelled: 'Cancelled',
  }
  return map[status] || status
}

// ─── Stock status ─────────────────────────────────────────────────────────────
export const stockStatus = (qty, reorder) => {
  if (qty === 0)        return { status: 'out',    label: 'Out of Stock', cls: 'chip-out' }
  if (qty <= reorder)   return { status: 'low',    label: 'Low Stock',   cls: 'chip-low' }
  return                       { status: 'normal', label: 'In Stock',    cls: 'chip-active' }
}

// ─── Role colours ─────────────────────────────────────────────────────────────
export const roleColors = {
  super_admin:       '#a78bfa',
  branch_manager:    '#4f8ef7',
  cashier:           '#2dd4bf',
  inventory_manager: '#f5a623',
  finance:           '#22c97a',
  purchase_admin:    '#f5485c',
}

export const roleLabels = {
  super_admin:       'Super Admin',
  branch_manager:    'Branch Manager',
  cashier:           'Cashier',
  inventory_manager: 'Inventory Mgr',
  finance:           'Finance',
  purchase_admin:    'Purchase Admin',
}

// ─── Generate new ID ──────────────────────────────────────────────────────────
export const newId = (prefix = 'id') => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

// ─── Clamp ────────────────────────────────────────────────────────────────────
export const clamp = (val, min, max) => Math.min(Math.max(val, min), max)

// ─── Search filter ────────────────────────────────────────────────────────────
export const matchSearch = (item, query, fields) => {
  if (!query) return true
  const q = query.toLowerCase()
  return fields.some((f) => String(item[f] || '').toLowerCase().includes(q))
}

import * as XLSX from 'xlsx'

// ─── Export to CSV ────────────────────────────────────────────────────────────
export const exportToCSV = (data, filename = 'export.csv', columns = null) => {
  if (!data || data.length === 0) {
    console.warn('No data to export')
    return
  }

  // Use provided columns or extract from first row
  const cols = columns || Object.keys(data[0])

  // Create CSV header
  const header = cols.join(',')

  // Create CSV rows
  const rows = data.map(row =>
    cols.map(col => {
      const val = row[col]
      // Escape quotes and wrap in quotes if contains comma or quotes
      if (val === null || val === undefined) return ''
      const str = String(val)
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`
      }
      return str
    }).join(',')
  )

  // Combine and add BOM for UTF-8 Excel compatibility
  const csv = '\uFEFF' + header + '\n' + rows.join('\n')

  // Create blob and download
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const link = document.createElement('a')
  const url = URL.createObjectURL(blob)
  link.setAttribute('href', url)
  link.setAttribute('download', filename)
  link.style.visibility = 'hidden'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

export const exportToExcel = (data, filename = 'export.xlsx', columns = null) => {
  if (!data || data.length === 0) {
    console.warn('No data to export')
    return
  }

  const cols = columns || Object.keys(data[0])
  const normalizedRows = data.map((row) => {
    const normalized = {}
    cols.forEach((col) => {
      normalized[col] = row[col] ?? ''
    })
    return normalized
  })

  const worksheet = XLSX.utils.json_to_sheet(normalizedRows, { header: cols })
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Report')
  XLSX.writeFile(workbook, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`)
}
