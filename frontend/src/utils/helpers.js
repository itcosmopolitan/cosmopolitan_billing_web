import { format, formatDistanceToNow, parseISO } from 'date-fns'

// ─── Currency formatting ──────────────────────────────────────────────────────
export const fmt = (amount, decimals = 0) => {
  if (amount === null || amount === undefined) return '—'
  return 'MVR ' + Number(amount).toLocaleString('en-MV', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

export const fmtNum = (n) => Number(n).toLocaleString('en-MV')

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

export const humanizeLabel = (value) => {
  if (value === null || value === undefined || value === '') return ''
  const text = String(value).trim()
  if (text === '') return ''
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b(id)\b/gi, 'ID')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

export const humanizeValue = (value) => {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') {
    const normalized = value.trim()
    if (normalized === '') return '—'

    const map = {
      true: 'Yes',
      false: 'No',
      yes: 'Yes',
      no: 'No',
      on: 'On',
      off: 'Off',
      enabled: 'Enabled',
      disabled: 'Disabled',
      intransit: 'In Transit',
      in_progress: 'In Progress',
      inprogress: 'In Progress',
      transit: 'In Transit',
      receive: 'Receive',
      received: 'Received',
      pending_approval: 'Pending Approval',
      pendingapproval: 'Pending Approval',
      approved: 'Approved',
      rejected: 'Rejected',
      cancelled: 'Cancelled',
      canceled: 'Cancelled',
      draft: 'Draft',
      partial: 'Partial',
      overdue: 'Overdue',
      active: 'Active',
      inactive: 'Inactive',
      paid: 'Paid',
      unpaid: 'Unpaid',
      pending: 'Pending',
      confirmed: 'Confirmed',
      low: 'Low',
      out: 'Out',
      low_stock: 'Low Stock',
      out_of_stock: 'Out of Stock',
    }

    const lower = normalized.toLowerCase()
    if (Object.prototype.hasOwnProperty.call(map, lower)) return map[lower]

    return normalized
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .replace(/\b(id)\b/gi, 'ID')
      .replace(/\b\w/g, (char) => char.toUpperCase())
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return value.map(humanizeValue).join(', ')
  }
  if (typeof value === 'object') {
    try { return JSON.stringify(value) }
    catch { return String(value) }
  }
  return String(value)
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
    intransit:'chip-transit',
    in_progress: 'chip-transit',
    inprogress: 'chip-transit',
    received: 'chip-paid',
    receive:  'chip-paid',
    low:      'chip-low',
    out:      'chip-out',
    cancelled:'chip-out',
    canceled: 'chip-out',
    inactive: 'chip-out',
    pending_approval: 'chip-pending',
    confirmed: 'chip-active',
  }
  return map[status] || 'chip-draft'
}

export const statusLabel = (status) => {
  const map = {
    paid: 'Paid', active: 'Active', pending: 'Pending', overdue: 'Overdue',
    draft: 'Draft', partial: 'Partial', transit: 'In Transit', intransit: 'In Transit', in_progress: 'In Progress', inprogress: 'In Progress', receive: 'Receive', received: 'Received',
    low: 'Low Stock', out: 'Out of Stock', cancelled: 'Cancelled', canceled: 'Cancelled', inactive: 'Inactive',
    pending_approval: 'Pending Approval', confirmed: 'Confirmed',
  }
  return map[status] || humanizeValue(status)
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
  branch_supervisor: '#f5a623',
  cashier:           '#2dd4bf',
}

export const roleLabels = {
  super_admin:       'Super Admin',
  branch_manager:    'Branch Manager',
  branch_supervisor: 'Branch Supervisor',
  cashier:           'Cashier',
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
