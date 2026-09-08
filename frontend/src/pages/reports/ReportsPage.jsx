
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { reportsAPI, AUTOCOMPLETE_BRANCH_URL } from '@/api'
import { fmt, fmtDate, fmtNum, fmtQty, exportToExcel } from '@/utils/helpers'
import {
  Card, SearchBar, PaginationBar, SortableHeader, AutocompleteDropdown,
  DatePicker, TableLoadingPanel, PageActionsMenu, buildListPageMenuActions,
  CustomizeColumnsModal, ColumnPrefsTrigger, ColumnPrefsSpacer,
} from '@/components/ui'
import * as Icon from '@/components/ui/Icons'
import useColumnPrefs from '@/hooks/useColumnPrefs'
import { useAppStore } from '@/store'

const FAVORITES_GROUP_ID = 'favorites'

const formatDate = (value) => (value ? fmtDate(value) : '—')
const formatCurrency = (value) => (value === null || value === undefined ? '—' : fmt(value))
const formatNumber = (value) => (value === null || value === undefined ? '—' : fmtNum(value))
const formatQty = (value) => (value === null || value === undefined ? '—' : fmtQty(value))
const formatCurrencyBlank = (value) => (value === null || value === undefined ? '' : formatCurrency(value))

/** Formats that can be summed in a report totals footer. */
const SUMMABLE_FORMATS = new Set(['currency', 'currency_blank', 'qty', 'number'])

/** Unit rates / averages — never sum these. */
const NON_SUMMABLE_KEYS = new Set([
  'unit_price',
  'unit_cost',
  'average_cost',
  'tax_rate',
  'days_to_expiry',
  'reorder_level',
  'sort_order',
  'margin_pct',
])

/** Reports that already encode their own totals / structure. */
const NO_FOOTER_TOTALS_REPORTS = new Set(['profit-loss'])

/** When set, footer only sums these keys (taxable is duplicated across CGST/SGST). */
const FOOTER_SUM_KEYS_BY_REPORT = {
  'tax-summary': new Set(['taxable_amount', 'tax_amount']),
  'tax-summary-detail': new Set(['transaction_amount', 'tax_amount']),
}

function isSummableColumn(column, reportId) {
  if (!column?.format || !SUMMABLE_FORMATS.has(column.format)) return false
  if (NON_SUMMABLE_KEYS.has(column.key)) return false
  const allowed = FOOTER_SUM_KEYS_BY_REPORT[reportId]
  if (allowed && !allowed.has(column.key)) return false
  return true
}

function computeColumnTotals(rows, columns, reportId) {
  if (!rows?.length || !columns?.length) return null
  const totals = {}
  let hasAny = false
  columns.forEach((column) => {
    if (!isSummableColumn(column, reportId)) return
    let sum = 0
    let counted = 0
    rows.forEach((row) => {
      const raw = row?.[column.key]
      if (raw === null || raw === undefined || raw === '') return
      const num = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(num)) return
      sum += num
      counted += 1
    })
    if (counted > 0) {
      totals[column.key] = sum
      hasAny = true
    }
  })
  return hasAny ? totals : null
}

const DRILLDOWN_PARAM_KEYS = [
  'date_from',
  'date_to',
  'branch_id',
  'branch_label',
  'payment_mode',
  'cashier_id',
  'customer_id',
  'item_id',
  'category_id',
  'vendor_id',
  'tax_name',
  'full_rate',
  'tax_percentage',
  'sort_by',
  'sort_order',
  'skip',
  'drill_from',
  'drill_label',
]

/** Parent filter snapshot carried on child URLs so Back restores parent, not child. */
const PARENT_FILTER_PARAM_KEYS = [
  'parent_date_from',
  'parent_date_to',
  'parent_branch_id',
  'parent_branch_label',
  'parent_sort_by',
  'parent_sort_order',
  'parent_skip',
]

const REPORT_URL_FILTER_KEYS = [...DRILLDOWN_PARAM_KEYS, ...PARENT_FILTER_PARAM_KEYS]

function readDrilldownFilters(searchParams) {
  const filters = {}
  REPORT_URL_FILTER_KEYS.forEach((key) => {
    const value = searchParams.get(key)
    if (value !== null && value !== '') filters[key] = value
  })
  return filters
}

function parentFiltersFromState({ dateFrom, dateTo, branchId, branchLabel, sortBy, sortOrder, skip }) {
  return {
    parent_date_from: dateFrom || '',
    parent_date_to: dateTo || '',
    ...(branchId ? { parent_branch_id: branchId } : {}),
    ...(branchLabel ? { parent_branch_label: branchLabel } : {}),
    ...(sortBy ? { parent_sort_by: sortBy } : {}),
    ...(sortOrder ? { parent_sort_order: sortOrder } : {}),
    ...(skip > 0 ? { parent_skip: String(skip) } : {}),
  }
}

function restoreParentFilters(urlFilters, fallbacks = {}) {
  const skipRaw = urlFilters.parent_skip
  const skip = skipRaw !== undefined && skipRaw !== '' ? Number(skipRaw) : 0
  return {
    date_from: urlFilters.parent_date_from || fallbacks.dateFrom || '',
    date_to: urlFilters.parent_date_to || fallbacks.dateTo || '',
    ...(urlFilters.parent_branch_id
      ? {
          branch_id: urlFilters.parent_branch_id,
          ...(urlFilters.parent_branch_label
            ? { branch_label: urlFilters.parent_branch_label }
            : {}),
        }
      : {}),
    ...(urlFilters.parent_sort_by ? { sort_by: urlFilters.parent_sort_by } : {}),
    ...(urlFilters.parent_sort_order ? { sort_order: urlFilters.parent_sort_order } : {}),
    ...(Number.isFinite(skip) && skip > 0 ? { skip: String(skip) } : {}),
  }
}

function drilldownChipLabel(filters) {
  if (filters.drill_label) return filters.drill_label
  if (filters.tax_name) return filters.tax_name
  if (filters.cashier_id) return 'Selected cashier'
  if (filters.customer_id) return 'Selected customer'
  if (filters.vendor_id) return 'Selected vendor'
  if (filters.payment_mode) return filters.payment_mode
  if (filters.category_id) return 'Selected category'
  if (filters.item_id) return 'Selected product'
  if (filters.branch_id) return 'Selected branch'
  return 'Filtered view'
}

const COLUMN_FORMATTERS = {
  date: formatDate,
  currency: formatCurrency,
  currency_blank: formatCurrencyBlank,
  number: formatNumber,
  qty: formatQty,
}

const DETAIL_PATH_BUILDERS = {
  invoice: (row) => (row.invoice_id ? `/sales?tab=invoices&view=${encodeURIComponent(row.invoice_id)}` : null),
  bill: (row) => (row.bill_id ? `/purchases?tab=bills&view=${encodeURIComponent(row.bill_id)}` : null),
  transfer: (row) => (row.transfer_id ? `/transfers/${encodeURIComponent(row.transfer_id)}/edit` : null),
  tax_txn: (row) => {
    const id = row.document_id
    if (!id) return null
    if (row.detail_kind === 'invoice') return `/sales?tab=invoices&view=${encodeURIComponent(id)}`
    if (row.detail_kind === 'bill') return `/purchases?tab=bills&view=${encodeURIComponent(id)}`
    if (row.detail_kind === 'credit_note') return `/sales/returns/${encodeURIComponent(id)}/edit`
    if (row.detail_kind === 'debit_note') return `/purchases/returns/${encodeURIComponent(id)}/edit`
    return null
  },
}

/** Client-side drilldown handlers keyed by report id (server catalog has no functions). */
const DRILLDOWN_HANDLERS = {
  'daily-sales': (row, ctx) => (row.date ? {
    reportId: 'daily-sales-detail',
    filters: {
      date_from: row.date,
      date_to: row.date,
      ...(ctx.branchId ? { branch_id: ctx.branchId } : {}),
    },
    label: formatDate(row.date),
  } : null),
  'product-sales': (row, ctx) => (row.item_id ? {
    reportId: 'product-sales-detail',
    filters: {
      date_from: ctx.dateFrom,
      date_to: ctx.dateTo,
      item_id: row.item_id,
      ...(ctx.branchId ? { branch_id: ctx.branchId } : {}),
    },
    label: row.product_name || row.product_code,
  } : null),
  'payment-sales': (row, ctx) => ({
    reportId: 'payment-sales-detail',
    filters: {
      date_from: ctx.dateFrom,
      date_to: ctx.dateTo,
      payment_mode: row.payment_mode ?? '__none__',
      ...(ctx.branchId ? { branch_id: ctx.branchId } : {}),
    },
    label: row.payment_method || 'Payment',
  }),
  'category-sales': (row, ctx) => ({
    reportId: 'category-sales-detail',
    filters: {
      date_from: ctx.dateFrom,
      date_to: ctx.dateTo,
      category_id: row.category_id || '__uncategorized__',
      ...(ctx.branchId ? { branch_id: ctx.branchId } : {}),
    },
    label: row.category || 'Uncategorized',
  }),
  'branch-sales': (row, ctx) => (row.branch_id ? {
    reportId: 'branch-sales-detail',
    filters: {
      date_from: ctx.dateFrom,
      date_to: ctx.dateTo,
      branch_id: row.branch_id,
    },
    label: row.branch,
  } : null),
  'cashier-sales': (row, ctx) => (row.cashier_id ? {
    reportId: 'cashier-sales-detail',
    filters: {
      date_from: ctx.dateFrom,
      date_to: ctx.dateTo,
      cashier_id: row.cashier_id,
      ...(ctx.branchId ? { branch_id: ctx.branchId } : {}),
    },
    label: row.cashier,
  } : null),
  'vendor-purchases': (row, ctx) => (row.vendor_id ? {
    reportId: 'vendor-purchases-detail',
    filters: {
      date_from: ctx.dateFrom,
      date_to: ctx.dateTo,
      vendor_id: row.vendor_id,
      ...(ctx.branchId ? { branch_id: ctx.branchId } : {}),
    },
    label: row.vendor,
  } : null),
  'product-purchases': (row, ctx) => (row.item_id ? {
    reportId: 'product-purchases-detail',
    filters: {
      date_from: ctx.dateFrom,
      date_to: ctx.dateTo,
      item_id: row.item_id,
      ...(ctx.branchId ? { branch_id: ctx.branchId } : {}),
    },
    label: row.product,
  } : null),
  'top-customers': (row, ctx) => ({
    reportId: 'top-customers-detail',
    filters: {
      date_from: ctx.dateFrom,
      date_to: ctx.dateTo,
      customer_id: row.customer_id || '__none__',
      ...(ctx.branchId ? { branch_id: ctx.branchId } : {}),
    },
    label: row.customer || 'Walk-in',
  }),
  'vendor-outstanding': (row, ctx) => (row.vendor_id ? {
    reportId: 'vendor-outstanding-detail',
    filters: {
      date_from: ctx.dateFrom,
      date_to: ctx.dateTo,
      vendor_id: row.vendor_id,
      ...(ctx.branchId ? { branch_id: ctx.branchId } : {}),
    },
    label: row.vendor,
  } : null),
  'tax-summary': (row, ctx) => (row.tax_name || row.tax_percentage != null ? {
    reportId: 'tax-summary-detail',
    filters: {
      date_from: ctx.dateFrom,
      date_to: ctx.dateTo,
      tax_name: row.tax_name || '',
      full_rate: row.full_rate ?? row.tax_percentage ?? '',
      tax_percentage: row.tax_percentage ?? '',
      ...(ctx.branchId ? { branch_id: ctx.branchId } : {}),
    },
    label: row.tax_name || `GST ${row.tax_percentage}%`,
  } : null),
}

function hydrateReport(report, category) {
  const columns = (report.columns || []).map((col) => ({
    ...col,
    formatter: col.format ? COLUMN_FORMATTERS[col.format] : undefined,
  }))
  const detailBuilder = report.detailType ? DETAIL_PATH_BUILDERS[report.detailType] : null
  const getDrilldown = DRILLDOWN_HANDLERS[report.id]
  return {
    ...report,
    categoryId: category.id,
    categoryLabel: category.label,
    columns,
    getDetailPath: typeof detailBuilder === 'function' ? detailBuilder : undefined,
    getDrilldown: typeof getDrilldown === 'function' ? getDrilldown : undefined,
  }
}

function hydrateCatalog(payload) {
  const categories = Array.isArray(payload?.categories) ? payload.categories : []
  const hydrated = categories.map((category) => ({
    ...category,
    reports: (category.reports || []).map((report) => hydrateReport(report, category)),
  }))
  const reportMap = {}
  hydrated.forEach((category) => {
    category.reports.forEach((report) => {
      reportMap[report.id] = report
    })
  })
  const favorites = Array.isArray(payload?.favorites)
    ? payload.favorites.filter((id) => reportMap[id])
    : []
  return { categories: hydrated, reportMap, favorites }
}

const LEGACY_FAVORITES_PREFIX = 'cosmo.reportFavorites.v1.'

function readLegacyFavoriteIds(user) {
  const keys = [
    `${LEGACY_FAVORITES_PREFIX}${user?.id || ''}`,
    `${LEGACY_FAVORITES_PREFIX}${user?.email || ''}`,
    `${LEGACY_FAVORITES_PREFIX}anon`,
  ].filter((key, index, all) => key && all.indexOf(key) === index)
  const merged = []
  const seen = new Set()
  keys.forEach((key) => {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return
      parsed.forEach((id) => {
        if (typeof id !== 'string' || !id || seen.has(id)) return
        seen.add(id)
        merged.push(id)
      })
    } catch {
      /* ignore */
    }
  })
  return merged
}

function clearLegacyFavoriteIds(user) {
  ;[
    `${LEGACY_FAVORITES_PREFIX}${user?.id || ''}`,
    `${LEGACY_FAVORITES_PREFIX}${user?.email || ''}`,
    `${LEGACY_FAVORITES_PREFIX}anon`,
  ].forEach((key) => {
    try { localStorage.removeItem(key) } catch { /* ignore */ }
  })
}

function buildReportPath(reportId, reportMap, extra = {}) {
  const params = new URLSearchParams()
  params.set('report', reportId)
  const categoryId = extra.report_group || reportMap[reportId]?.categoryId || ''
  if (categoryId) params.set('report_group', categoryId)
  Object.entries(extra).forEach(([key, value]) => {
    if (key === 'report_group') return
    if (value === null || value === undefined || value === '') return
    params.set(key, String(value))
  })
  return `/reports?${params.toString()}`
}

export default function ReportsPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const reportId = searchParams.get('report') || ''
  const reportGroup = searchParams.get('report_group') || ''

  const user = useAppStore((s) => s.user)
  const [categories, setCategories] = useState([])
  const [reportMap, setReportMap] = useState({})
  const [favoriteIds, setFavoriteIds] = useState([])
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogError, setCatalogError] = useState(false)
  const [favoritesSaving, setFavoritesSaving] = useState(false)

  const applyCatalog = useCallback((payload) => {
    const next = hydrateCatalog(payload)
    setCategories(next.categories)
    setReportMap(next.reportMap)
    setFavoriteIds(next.favorites)
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setCatalogLoading(true)
      setCatalogError(false)
      try {
        let payload = await reportsAPI.catalog()
        if (cancelled) return

        // One-time migrate browser-local favorites into the server store.
        const serverFavorites = Array.isArray(payload?.favorites) ? payload.favorites : []
        if (serverFavorites.length === 0) {
          const legacy = readLegacyFavoriteIds(user).filter((id) =>
            (payload?.categories || []).some((cat) =>
              (cat.reports || []).some((report) => report.id === id),
            ),
          )
          if (legacy.length > 0) {
            try {
              payload = await reportsAPI.putCatalog({ favorites: legacy })
              clearLegacyFavoriteIds(user)
            } catch (migrateErr) {
              console.error(migrateErr)
            }
          }
        } else {
          clearLegacyFavoriteIds(user)
        }

        if (cancelled) return
        applyCatalog(payload)
      } catch (err) {
        console.error(err)
        if (!cancelled) {
          setCatalogError(true)
          setCategories([])
          setReportMap({})
          setFavoriteIds([])
          toast.error('Could not load reports catalog')
        }
      } finally {
        if (!cancelled) setCatalogLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [applyCatalog, user])

  const isFavorite = useCallback(
    (id) => favoriteIds.includes(id),
    [favoriteIds],
  )

  const toggleFavorite = useCallback(async (id) => {
    if (!reportMap[id] || favoritesSaving) return
    const previous = favoriteIds
    const next = previous.includes(id)
      ? previous.filter((x) => x !== id)
      : [...previous, id]
    setFavoriteIds(next)
    setFavoritesSaving(true)
    try {
      const payload = await reportsAPI.putCatalog({ favorites: next })
      applyCatalog(payload)
    } catch (err) {
      console.error(err)
      setFavoriteIds(previous)
      toast.error('Could not update favorites')
    } finally {
      setFavoritesSaving(false)
    }
  }, [reportMap, favoritesSaving, favoriteIds, applyCatalog])

  const selectedReport = reportId ? (reportMap[reportId] || null) : null
  const listPath = reportGroup
    ? `/reports?report_group=${encodeURIComponent(reportGroup)}`
    : '/reports'

  if (catalogLoading) {
    return (
      <div className="page-container">
        <TableLoadingPanel label="Loading reports…" />
      </div>
    )
  }

  if (catalogError) {
    return (
      <div className="page-container">
        <Card>
          <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)' }}>
            Could not load the reports catalog. Refresh the page to try again.
          </div>
        </Card>
      </div>
    )
  }

  if (reportId && !selectedReport) {
    return <NavigateToReportsList />
  }

  if (!selectedReport) {
    return (
      <ReportsListPage
        reportGroup={reportGroup}
        categories={categories}
        reportMap={reportMap}
        favoriteIds={favoriteIds}
        isFavorite={isFavorite}
        onToggleFavorite={toggleFavorite}
        onSelectGroup={(id) => navigate(`/reports?report_group=${encodeURIComponent(id)}`)}
        onOpen={(id) => {
          const params = new URLSearchParams()
          params.set('report', id)
          if (reportGroup) params.set('report_group', reportGroup)
          else params.set('report_group', reportMap[id]?.categoryId || '')
          navigate(`/reports?${params.toString()}`)
        }}
      />
    )
  }

  return <ReportDetailPage key={selectedReport.id} report={selectedReport} reportMap={reportMap} onBack={() => navigate(listPath)} />
}

function NavigateToReportsList() {
  const navigate = useNavigate()
  useEffect(() => {
    toast.error('Unknown report.')
    navigate('/reports', { replace: true })
  }, [navigate])
  return null
}

function FolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  )
}

function ReportsListPage({
  reportGroup,
  categories,
  reportMap,
  favoriteIds,
  isFavorite,
  onToggleFavorite,
  onSelectGroup,
  onOpen,
}) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()

  const favoriteReports = useMemo(
    () => favoriteIds.map((id) => reportMap[id]).filter((r) => r && !r.listHidden),
    [favoriteIds, reportMap],
  )

  const firstCategoryId = categories[0]?.id || ''

  const sidebarCategories = useMemo(() => ([
    { id: FAVORITES_GROUP_ID, label: 'Favorites', reports: favoriteReports, isFavorites: true },
    ...categories.map((category) => ({ ...category, isFavorites: false })),
  ]), [favoriteReports, categories])

  const knownGroupIds = useMemo(
    () => new Set(sidebarCategories.map((c) => c.id)),
    [sidebarCategories],
  )

  const defaultGroupId = favoriteReports.length > 0
    ? FAVORITES_GROUP_ID
    : firstCategoryId

  // Land on Favorites when available; otherwise the first report category.
  useEffect(() => {
    if (!defaultGroupId) return
    if (reportGroup && knownGroupIds.has(reportGroup)) return
    navigate(`/reports?report_group=${encodeURIComponent(defaultGroupId)}`, { replace: true })
  }, [reportGroup, knownGroupIds, defaultGroupId, navigate])

  const activeGroupId = knownGroupIds.has(reportGroup) ? reportGroup : defaultGroupId
  const activeCategory = sidebarCategories.find((c) => c.id === activeGroupId) || sidebarCategories[0]

  const visibleReports = (activeCategory?.reports || []).filter((report) => (
    !report.listHidden
    && (
      !needle
      || report.label.toLowerCase().includes(needle)
      || (activeCategory.label || '').toLowerCase().includes(needle)
      || (report.categoryLabel || '').toLowerCase().includes(needle)
    )
  ))

  return (
    <div className="page-container">
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 18, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', flex: '0 0 auto' }}>Reports Center</h1>
        <div style={{ flex: 1, minWidth: 240, maxWidth: 420, margin: '0 auto' }}>
          <SearchBar value={query} onChange={setQuery} placeholder="Search reports" style={{ width: '100%' }} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '240px minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
        <aside style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-default)',
          borderRadius: 10,
          overflow: 'hidden',
        }}>
          <div style={{
            padding: '12px 14px 8px',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.6,
            color: 'var(--text-muted)',
          }}>
            REPORT CATEGORY
          </div>
          {sidebarCategories.map((category) => {
            const active = category.id === activeGroupId
            return (
              <button
                key={category.id}
                type="button"
                onClick={() => onSelectGroup(category.id)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 14px',
                  border: 'none',
                  background: active ? 'var(--blue-bg)' : 'transparent',
                  color: active ? 'var(--blue)' : 'var(--text-secondary)',
                  fontWeight: active ? 600 : 500,
                  fontSize: 13.5,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span style={{ display: 'inline-flex', opacity: 0.85 }}>
                  {category.isFavorites
                    ? <Icon.Star size={16} filled={favoriteReports.length > 0} />
                    : <FolderIcon />}
                </span>
                <span style={{ flex: 1 }}>{category.label}</span>
                {category.isFavorites && favoriteReports.length > 0 && (
                  <span style={{
                    minWidth: 18,
                    height: 18,
                    padding: '0 5px',
                    borderRadius: 9,
                    background: active ? 'rgba(255,255,255,0.55)' : 'var(--bg-subtle, rgba(0,0,0,0.05))',
                    color: active ? 'var(--blue)' : 'var(--text-muted)',
                    fontSize: 11,
                    fontWeight: 700,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}>
                    {favoriteReports.length}
                  </span>
                )}
              </button>
            )
          })}
        </aside>

        <section style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-default)',
          borderRadius: 10,
          overflow: 'hidden',
          minHeight: 360,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 18px 12px' }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{activeCategory?.label || 'Reports'}</h2>
            <span style={{
              minWidth: 22,
              height: 22,
              padding: '0 7px',
              borderRadius: 11,
              background: 'var(--blue-bg)',
              color: 'var(--blue)',
              fontSize: 12,
              fontWeight: 700,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              {visibleReports.length}
            </span>
          </div>
          <table className="data-table" style={{ minWidth: 0 }}>
            <thead>
              <tr>
                <th>REPORT NAME</th>
                <th className="report-list-fav-th" aria-label="Favorite" />
              </tr>
            </thead>
            <tbody>
              {visibleReports.length === 0 ? (
                <tr>
                  <td colSpan={2} style={{ textAlign: 'center', padding: 28, color: 'var(--text-muted)' }}>
                    {activeCategory?.isFavorites && !needle
                      ? 'No favorite reports yet. Hover a report and click the star to add it here.'
                      : 'No reports match that search.'}
                  </td>
                </tr>
              ) : visibleReports.map((report) => {
                const favorited = isFavorite(report.id)
                return (
                  <tr
                    key={report.id}
                    className="report-list-row"
                    style={{ cursor: 'pointer' }}
                    onClick={() => onOpen(report.id)}
                  >
                    <td>
                      <span style={{ color: 'var(--blue)', fontWeight: 500 }}>{report.label}</span>
                      {activeCategory?.isFavorites && report.categoryLabel && (
                        <span style={{ marginLeft: 8, color: 'var(--text-muted)', fontSize: 12, fontWeight: 500 }}>
                          {report.categoryLabel}
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right', width: 44 }}>
                      <button
                        type="button"
                        className={`report-fav-btn${favorited ? ' is-favorite' : ''}`}
                        aria-label={favorited ? `Remove ${report.label} from favorites` : `Add ${report.label} to favorites`}
                        aria-pressed={favorited}
                        title={favorited ? 'Remove from favorites' : 'Add to favorites'}
                        onClick={(e) => {
                          e.stopPropagation()
                          onToggleFavorite(report.id)
                        }}
                      >
                        <Icon.Star size={16} filled={favorited} />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  )
}

function ReportDetailPage({ report, reportMap, onBack }) {
  const navigate = useNavigate()
  const columnPrefs = useColumnPrefs(`reports.${report.id}`)
  const [searchParams] = useSearchParams()
  const urlFilterKey = searchParams.toString()
  const urlFilters = useMemo(() => readDrilldownFilters(searchParams), [searchParams, urlFilterKey])
  const today = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const defaultFrom = useMemo(() => {
    const from = new Date()
    from.setDate(from.getDate() - 30)
    return from.toISOString().slice(0, 10)
  }, [])

  const [dateFrom, setDateFrom] = useState(() => searchParams.get('date_from') || defaultFrom)
  const [dateTo, setDateTo] = useState(() => searchParams.get('date_to') || today)
  const [branchId, setBranchId] = useState(() => searchParams.get('branch_id') || '')
  const [branchLabel, setBranchLabel] = useState(() => searchParams.get('branch_label') || '')
  const [sortBy, setSortBy] = useState(
    () => searchParams.get('sort_by') || report.defaultSort || report.columns[0]?.key,
  )
  const [sortOrder, setSortOrder] = useState(() => searchParams.get('sort_order') || 'desc')
  const [skip, setSkip] = useState(() => {
    const raw = Number(searchParams.get('skip') || 0)
    return Number.isFinite(raw) && raw > 0 ? raw : 0
  })
  const [limit, setLimit] = useState(50)
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [runKey, setRunKey] = useState(Date.now())

  const columnByKey = useMemo(() => {
    const map = new Map()
    report.columns.forEach((col) => map.set(col.key, col))
    return map
  }, [report.columns])

  const visibleColumns = useMemo(() => {
    if (!columnPrefs.ready) return report.columns
    return columnPrefs.visibleIds.map((id) => columnByKey.get(id)).filter(Boolean)
  }, [columnPrefs.ready, columnPrefs.visibleIds, columnByKey, report.columns])

  const tableColSpan = visibleColumns.length + (columnPrefs.ready ? 1 : 0)

  const columnTotals = useMemo(() => {
    if (NO_FOOTER_TOTALS_REPORTS.has(report.id) || loading || rows.length === 0) return null
    return computeColumnTotals(rows, visibleColumns, report.id)
  }, [report.id, loading, rows, visibleColumns])

  const totalsLabel = rows.length < total ? 'Page total' : 'Total'
  const totalsLabelColumnKey = useMemo(() => {
    if (!columnTotals) return null
    const firstNonSummable = visibleColumns.find((col) => !Object.prototype.hasOwnProperty.call(columnTotals, col.key))
    return firstNonSummable?.key || visibleColumns[0]?.key || null
  }, [columnTotals, visibleColumns])

  const drillFilters = useMemo(() => {
    const {
      date_from: _df,
      date_to: _dt,
      branch_id: _bid,
      branch_label: _bl,
      drill_from: _from,
      drill_label: _label,
      parent_date_from: _pdf,
      parent_date_to: _pdt,
      parent_branch_id: _pbid,
      parent_branch_label: _pbl,
      parent_sort_by: _psb,
      parent_sort_order: _pso,
      parent_skip: _psk,
      sort_by: _sb,
      sort_order: _so,
      skip: _sk,
      ...rest
    } = urlFilters
    return rest
  }, [urlFilters])

  const isDrilldown = Boolean(urlFilters.drill_from || Object.keys(drillFilters).length > 0)
  const parentReport = urlFilters.drill_from ? reportMap[urlFilters.drill_from] : null

  useEffect(() => {
    // Child URLs carry drill row filters in date_from/date_to/branch_*.
    // Parent URLs (including Back from child) carry only that report's own filters —
    // never inherit child-only drill dims like item_id / payment_mode.
    setDateFrom(urlFilters.date_from || defaultFrom)
    setDateTo(urlFilters.date_to || today)
    setBranchId(urlFilters.branch_id || '')
    setBranchLabel(
      urlFilters.branch_label
      || (urlFilters.branch_id && urlFilters.drill_from === 'branch-sales' ? (urlFilters.drill_label || '') : '')
      || '',
    )
    setSortBy(urlFilters.sort_by || report.defaultSort || report.columns[0]?.key)
    setSortOrder(urlFilters.sort_order === 'asc' || urlFilters.sort_order === 'desc' ? urlFilters.sort_order : 'desc')
    const nextSkip = Number(urlFilters.skip || 0)
    setSkip(Number.isFinite(nextSkip) && nextSkip > 0 ? nextSkip : 0)
    setRows([])
    setTotal(0)
    setRunKey(Date.now())
  }, [report.id, report.defaultSort, urlFilterKey, defaultFrom, today])

  useEffect(() => {
    let cancelled = false
    const fetchData = async () => {
      setLoading(true)
      try {
        // Prefer local Branch filter state; fall back to URL so drill-down
        // branch selection is never dropped before state sync completes.
        const appliedBranchId = branchId || urlFilters.branch_id || ''
        const params = {
          branch_id: appliedBranchId ? appliedBranchId : null,
          date_from: dateFrom,
          date_to: dateTo,
          sort_by: sortBy,
          sort_order: sortOrder,
          skip,
          limit: report.id === 'profit-loss' ? Math.max(limit, 100) : limit,
          ...drillFilters,
        }
        const response = await reportsAPI[report.api](params)
        const payload = response?.data ?? response
        const data = payload.items ?? payload
        if (cancelled) return
        setRows(Array.isArray(data) ? data : [])
        setTotal(typeof payload.total === 'number' ? payload.total : Array.isArray(data) ? data.length : 0)
      } catch (error) {
        console.error(error)
        if (!cancelled) {
          setRows([])
          setTotal(0)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchData()
    return () => { cancelled = true }
  }, [report, branchId, dateFrom, dateTo, sortBy, sortOrder, skip, limit, runKey, drillFilters, urlFilters.branch_id])

  const handleSort = (key) => {
    const nextOrder = sortBy === key && sortOrder === 'asc' ? 'desc' : 'asc'
    setSortBy(key)
    setSortOrder(nextOrder)
    setSkip(0)
  }

  const exportExcel = () => {
    if (!rows || rows.length === 0) {
      toast.error('No data available to export.')
      return
    }
    const exportData = rows.map((row) => {
      const entry = {}
      visibleColumns.forEach((col) => {
        const value = row[col.key]
        entry[col.label] = value === null || value === undefined ? '' : value
      })
      return entry
    })
    exportToExcel(exportData, `${report.label.replace(/\s+/g, '_')}_${dateFrom}_to_${dateTo}.xlsx`)
    toast.success('Excel export ready')
  }

  const openDrilldown = (row) => {
    if (typeof report.getDrilldown !== 'function') return
    const drill = report.getDrilldown(row, { dateFrom, dateTo, branchId })
    if (!drill?.reportId) return
    const filters = { ...(drill.filters || {}) }
    // Always carry the selected Branch filter into the drill-down register.
    // Row-level branch (branch-wise sales) wins when already present.
    if (branchId && !filters.branch_id) {
      filters.branch_id = branchId
    }
    if (filters.branch_id) {
      filters.branch_label = branchLabel
        || (report.id === 'branch-sales' ? (drill.label || '') : '')
        || filters.branch_label
        || ''
      if (!filters.branch_label) delete filters.branch_label
    }
    navigate(buildReportPath(drill.reportId, reportMap, {
      ...filters,
      drill_from: report.id,
      drill_label: drill.label || '',
      // Keep parent date/branch/sort snapshot separate from child drill filters.
      ...parentFiltersFromState({
        dateFrom, dateTo, branchId, branchLabel, sortBy, sortOrder, skip,
      }),
    }))
  }

  const clearDrilldown = () => {
    if (parentReport) {
      // Restore the parent report with its own saved filters — do not reuse
      // the child's narrowed date_from/date_to (e.g. a single daily-sales day).
      navigate(buildReportPath(parentReport.id, reportMap, restoreParentFilters(urlFilters, {
        dateFrom: defaultFrom,
        dateTo: today,
      })))
      return
    }
    navigate(buildReportPath(report.id, reportMap, {
      date_from: dateFrom,
      date_to: dateTo,
      ...(branchId ? { branch_id: branchId, ...(branchLabel ? { branch_label: branchLabel } : {}) } : {}),
      ...(sortBy ? { sort_by: sortBy } : {}),
      ...(sortOrder ? { sort_order: sortOrder } : {}),
      ...(skip > 0 ? { skip: String(skip) } : {}),
    }))
  }

  return (
    <div className="page-container">
      <div className="section-hdr">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to reports"
          title="Back to reports"
          style={{
            flexShrink: 0,
            width: 36,
            height: 36,
            padding: 0,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 8,
            border: '1px solid var(--border-subtle)',
            background: 'var(--bg-raised)',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
          }}
        >
          <Icon.ChevronLeft size={20} />
        </button>
        <div style={{
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flex: 1,
          flexWrap: 'wrap',
        }}>
          <h2 style={{ margin: 0, minWidth: 0, flex: '0 1 auto' }}>{report.label}</h2>
          {report.categoryLabel && (
            <span style={{
              flexShrink: 0,
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--blue)',
              background: 'var(--blue-bg)',
              padding: '4px 10px',
              borderRadius: 8,
              whiteSpace: 'nowrap',
            }}>
              {report.categoryLabel}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 'auto' }}>
          <PageActionsMenu actions={buildListPageMenuActions({
            onExport: exportExcel,
            onRefresh: () => {
              setSkip(0)
              setRunKey(Date.now())
              toast.success('Report refreshed')
            },
          })} />
        </div>
      </div>

      {isDrilldown && (
        <div style={{
          marginBottom: 14,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          fontSize: 13,
          color: 'var(--text-secondary)',
        }}>
          {parentReport && (
            <>
              <button
                type="button"
                onClick={clearDrilldown}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--blue)',
                  fontWeight: 600,
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                {parentReport.label}
              </button>
              <span aria-hidden>›</span>
            </>
          )}
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '4px 10px',
            borderRadius: 8,
            background: 'var(--blue-bg)',
            color: 'var(--blue)',
            fontWeight: 600,
          }}>
            {drilldownChipLabel(urlFilters)}
            <button
              type="button"
              onClick={clearDrilldown}
              aria-label="Clear drilldown filter"
              style={{
                border: 'none',
                background: 'transparent',
                color: 'inherit',
                cursor: 'pointer',
                fontSize: 14,
                lineHeight: 1,
                padding: 0,
              }}
            >
              ×
            </button>
          </span>
          <span style={{ color: 'var(--text-muted)' }}>
            {report.id.endsWith('-detail') && (report.api === 'salesLines' || report.api === 'purchaseLines')
              ? 'Showing matching line items'
              : 'Showing matching detail rows'}
          </span>
        </div>
      )}

      <div style={{ marginBottom: 18, display: 'grid', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(160px, 220px))', gap: 12, alignItems: 'end' }}>
          <div>
            <label className="form-label">From</label>
            <DatePicker value={dateFrom} onChange={setDateFrom} />
          </div>
          <div>
            <label className="form-label">To</label>
            <DatePicker value={dateTo} onChange={setDateTo} />
          </div>
          <div>
            <label className="form-label">Branch</label>
            <AutocompleteDropdown
              value={branchId}
              selectedLabel={branchLabel || undefined}
              onChange={(id) => {
                setBranchId(id)
                if (!id) setBranchLabel('')
              }}
              onSelectOption={(opt) => setBranchLabel(opt?.label || '')}
              fetchUrl={AUTOCOMPLETE_BRANCH_URL}
              fetchParams={{ retail_only: false }}
              prependOptions={[{ id: '', label: 'All Branches' }]}
              isSearchFieldRequired={false}
              placeholder="All Branches"
            />
          </div>
        </div>
      </div>

      <Card title={report.label} bodyPadding={false}>
        <div style={{ padding: 16, overflowX: 'auto' }}>
          <table className="data-table" style={{ minWidth: 920 }}>
            <thead>
              <tr>
                {columnPrefs.ready && (
                  <ColumnPrefsTrigger onClick={columnPrefs.openCustomize} />
                )}
                {visibleColumns.map((column) => (
                  column.sortable === false ? (
                    <th key={column.key} className={column.align === 'right' ? 'text-right' : ''}>{column.label}</th>
                  ) : (
                    <SortableHeader
                      key={column.key}
                      label={column.label}
                      sortKey={column.key}
                      sortBy={sortBy}
                      sortOrder={sortOrder}
                      onSort={handleSort}
                      align={column.align || 'left'}
                    />
                  )
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={tableColSpan} style={{ padding: 0 }}>
                    <TableLoadingPanel label="Loading report data…" />
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={tableColSpan} style={{ textAlign: 'center', padding: 28 }}>No records match the selected filters.</td>
                </tr>
              ) : (
                rows.map((row, index) => {
                  const isPnL = report.id === 'profit-loss'
                  const emphasis = isPnL && (row.row_type === 'header' || row.row_type === 'section_total' || row.row_type === 'result')
                  const detailPath = typeof report.getDetailPath === 'function' ? report.getDetailPath(row) : null
                  const canDrill = typeof report.getDrilldown === 'function'
                    ? Boolean(report.getDrilldown(row, { dateFrom, dateTo, branchId }))
                    : false
                  const clickable = Boolean(detailPath || canDrill)
                  const rowStyle = isPnL
                    ? {
                        fontWeight: emphasis ? 700 : 400,
                        background: row.row_type === 'result' ? 'var(--bg-subtle, rgba(0,0,0,0.03))' : undefined,
                      }
                    : clickable
                      ? { cursor: 'pointer' }
                      : undefined
                  return (
                    <tr
                      key={index}
                      style={rowStyle}
                      title={canDrill ? 'Click to view detail register' : undefined}
                      onClick={() => {
                        if (detailPath) navigate(detailPath)
                        else if (canDrill) openDrilldown(row)
                      }}
                    >
                      {columnPrefs.ready && <ColumnPrefsSpacer />}
                      {visibleColumns.map((column) => {
                        const value = row[column.key]
                        const rendered = column.formatter ? column.formatter(value, row) : value
                        const alignClass =
                          column.align === 'right' ? 'text-right' : column.align === 'center' ? 'text-center' : ''
                        const isNameCol = ['invoice_number', 'bill_number', 'transfer_number', 'entry_number', 'tax_name', 'date', 'product_code', 'product_name', 'product', 'category', 'branch', 'cashier', 'payment_method', 'vendor', 'customer'].includes(column.key)
                        return (
                          <td
                            key={column.key}
                            className={alignClass}
                            style={{
                              ...(isPnL && column.key === 'account' && row.row_type === 'detail' ? { paddingLeft: 28 } : {}),
                              ...(clickable && isNameCol ? { color: 'var(--blue)', fontWeight: 500 } : {}),
                            }}
                          >
                            {rendered !== null && rendered !== undefined && rendered !== ''
                              ? rendered
                              : (isPnL ? '' : '—')}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })
              )}
            </tbody>
            {columnTotals && (
              <tfoot>
                <tr
                  style={{
                    background: 'var(--bg-subtle, rgba(0,0,0,0.04))',
                    borderTop: '1px solid var(--border-default)',
                    fontWeight: 700,
                  }}
                >
                  {columnPrefs.ready && <ColumnPrefsSpacer />}
                  {visibleColumns.map((column) => {
                    const alignClass =
                      column.align === 'right' ? 'text-right' : column.align === 'center' ? 'text-center' : ''
                    if (Object.prototype.hasOwnProperty.call(columnTotals, column.key)) {
                      const value = columnTotals[column.key]
                      const rendered = column.formatter ? column.formatter(value) : value
                      return (
                        <td key={column.key} className={alignClass}>
                          {rendered}
                        </td>
                      )
                    }
                    return (
                      <td key={column.key} className={alignClass} style={{ color: 'var(--text-secondary)' }}>
                        {column.key === totalsLabelColumnKey ? totalsLabel : ''}
                      </td>
                    )
                  })}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </Card>

      <div style={{ marginTop: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          Showing {rows.length} of {total} record{total === 1 ? '' : 's'}.
          {typeof report.getDrilldown === 'function' && !isDrilldown
            ? ' Click a row to open its detail report.'
            : ''}
        </div>
        <PaginationBar
          total={total}
          skip={skip}
          limit={limit}
          onSkipChange={setSkip}
          onLimitChange={setLimit}
          disabled={loading}
        />
      </div>

      <CustomizeColumnsModal
        open={columnPrefs.customizeOpen}
        onClose={columnPrefs.closeCustomize}
        defs={columnPrefs.defs}
        value={columnPrefs.prefs}
        onSave={columnPrefs.savePrefs}
      />
    </div>
  )
}

