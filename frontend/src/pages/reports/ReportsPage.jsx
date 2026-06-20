
import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { reportsAPI } from '@/api'
import { useAppStore } from '@/store'
import { fmt, fmtDate, fmtNum, exportToExcel } from '@/utils/helpers'
import { SALES_INVOICES, PURCHASE_BILLS } from '@/utils/seedData'
import { SectionHeader, Card, Tabs, SearchBar, PaginationBar, SortableHeader } from '@/components/ui'

const formatDate = (value) => (value ? fmtDate(value) : '—')
const formatCurrency = (value) => (value === null || value === undefined ? '—' : fmt(value, 2))
const formatNumber = (value) => (value === null || value === undefined ? '—' : fmtNum(value))
const formatText = (value) => (value === null || value === undefined ? '—' : String(value))

const REPORT_CATEGORIES = [
  {
    id: 'sales',
    label: 'Sales',
    reports: [
      {
        id: 'sales-register',
        label: 'Sales Register',
        api: 'salesRegister',
        ReportdefaultSort: 'date',
        columns: [
          { key: 'invoice_number', label: 'Invoice Number', sortable: true },
          { key: 'invoice_date', label: 'Invoice Date', sortable: true, formatter: formatDate },
          { key: 'customer', label: 'Customer', sortable: true },
          { key: 'branch', label: 'Branch', sortable: true },
          { key: 'cashier', label: 'Cashier', sortable: true },
          { key: 'taxable_amount', label: 'Taxable Amount', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'tax_amount', label: 'Tax Amount', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'discount', label: 'Discount', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'net_amount', label: 'Net Amount', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'payment_mode', label: 'Payment Mode', sortable: true },
          { key: 'status', label: 'Status', sortable: true },
        ],
      },
      {
        id: 'daily-sales',
        label: 'Daily Sales',
        api: 'dailySales',
        defaultSort: 'date',
        columns: [
          { key: 'date', label: 'Date', sortable: true, formatter: formatDate },
          { key: 'invoice_count', label: 'Invoice Count', align: 'right', sortable: true, formatter: formatNumber },
          { key: 'quantity_sold', label: 'Quantity Sold', align: 'right', sortable: true, formatter: formatNumber },
          { key: 'gross_sales', label: 'Gross Sales', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'discounts', label: 'Discounts', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'tax', label: 'Tax', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'net_sales', label: 'Net Sales', align: 'right', sortable: true, formatter: formatCurrency },
        ],
      },
      {
        id: 'product-sales',
        label: 'Product-wise Sales',
        api: 'productSales',
        defaultSort: 'sales_value',
        columns: [
          { key: 'product_code', label: 'Product Code', sortable: true },
          { key: 'product_name', label: 'Product Name', sortable: true },
          { key: 'category', label: 'Category', sortable: true },
          { key: 'quantity_sold', label: 'Quantity Sold', align: 'right', sortable: true, formatter: formatNumber },
          { key: 'sales_value', label: 'Sales Value', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'cost_value', label: 'Cost Value', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'profit', label: 'Profit', align: 'right', sortable: true, formatter: formatCurrency },
        ],
      },
      {
        id: 'category-sales',
        label: 'Category-wise Sales',
        api: 'categorySales',
        defaultSort: 'sales_value',
        columns: [
          { key: 'category', label: 'Category', sortable: true },
          { key: 'quantity_sold', label: 'Quantity Sold', align: 'right', sortable: true, formatter: formatNumber },
          { key: 'sales_value', label: 'Sales Value', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'cost_value', label: 'Cost Value', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'profit', label: 'Profit', align: 'right', sortable: true, formatter: formatCurrency },
        ],
      },
      {
        id: 'branch-sales',
        label: 'Branch-wise Sales',
        api: 'branchSales',
        defaultSort: 'sales_amount',
        columns: [
          { key: 'branch', label: 'Branch', sortable: true },
          { key: 'invoice_count', label: 'Invoice Count', align: 'right', sortable: true, formatter: formatNumber },
          { key: 'sales_amount', label: 'Sales Amount', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'tax_amount', label: 'Tax Amount', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'discount_amount', label: 'Discount Amount', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'net_sales', label: 'Net Sales', align: 'right', sortable: true, formatter: formatCurrency },
        ],
      },
      {
        id: 'cashier-sales',
        label: 'Cashier-wise Sales',
        api: 'cashierSales',
        defaultSort: 'sales_amount',
        columns: [
          { key: 'cashier', label: 'Cashier', sortable: true },
          { key: 'invoice_count', label: 'Invoice Count', align: 'right', sortable: true, formatter: formatNumber },
          { key: 'sales_amount', label: 'Sales Amount', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'tax_amount', label: 'Tax Amount', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'discount_amount', label: 'Discount Amount', align: 'right', sortable: true, formatter: formatCurrency },
        ],
      },
    ],
  },
  {
    id: 'purchase',
    label: 'Purchase',
    reports: [
      {
        id: 'purchase-register',
        label: 'Purchase Register',
        api: 'purchaseRegister',
        defaultSort: 'date',
        columns: [
          { key: 'bill_number', label: 'Bill Number', sortable: true },
          { key: 'bill_date', label: 'Bill Date', sortable: true, formatter: formatDate },
          { key: 'vendor', label: 'Vendor', sortable: true },
          { key: 'branch', label: 'Branch', sortable: true },
          { key: 'subtotal', label: 'Subtotal', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'tax', label: 'Tax', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'total', label: 'Total', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'paid', label: 'Paid', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'balance', label: 'Balance', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'status', label: 'Status', sortable: true },
        ],
      },
      {
        id: 'vendor-purchases',
        label: 'Vendor-wise Purchase',
        api: 'vendorPurchases',
        defaultSort: 'purchase_amount',
        columns: [
          { key: 'vendor', label: 'Vendor', sortable: true },
          { key: 'purchase_count', label: 'Purchase Count', align: 'right', sortable: true, formatter: formatNumber },
          { key: 'purchase_amount', label: 'Purchase Amount', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'paid_amount', label: 'Paid Amount', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'outstanding_amount', label: 'Outstanding Amount', align: 'right', sortable: true, formatter: formatCurrency },
        ],
      },
      {
        id: 'product-purchases',
        label: 'Product-wise Purchase',
        api: 'productPurchases',
        defaultSort: 'quantity_purchased',
        columns: [
          { key: 'product', label: 'Product', sortable: true },
          { key: 'quantity_purchased', label: 'Quantity Purchased', align: 'right', sortable: true, formatter: formatNumber },
          { key: 'purchase_cost', label: 'Purchase Cost', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'average_cost', label: 'Average Cost', align: 'right', sortable: true, formatter: formatCurrency },
        ],
      },
    ],
  },
  {
    id: 'inventory',
    label: 'Inventory',
    reports: [
      {
        id: 'current-stock',
        label: 'Current Stock',
        api: 'currentStock',
        defaultSort: 'product_code',
        columns: [
          { key: 'product_code', label: 'Product Code', sortable: true },
          { key: 'product_name', label: 'Product Name', sortable: true },
          { key: 'category', label: 'Category', sortable: true },
          { key: 'branch', label: 'Branch', sortable: true },
          { key: 'available_stock', label: 'Available Stock', align: 'right', sortable: true, formatter: formatNumber },
          { key: 'reserved_stock', label: 'Reserved Stock', align: 'right', sortable: true, formatter: formatNumber },
          { key: 'stock_value', label: 'Stock Value', align: 'right', sortable: true, formatter: formatCurrency },
        ],
      },
      {
        id: 'stock-movement',
        label: 'Stock Movement',
        api: 'stockMovement',
        defaultSort: 'date',
        columns: [
          { key: 'date', label: 'Date', sortable: true, formatter: formatDate },
          { key: 'product', label: 'Product', sortable: true },
          { key: 'movement_type', label: 'Movement Type', sortable: true },
          { key: 'quantity', label: 'Quantity', align: 'right', sortable: true, formatter: formatNumber },
          { key: 'reference_number', label: 'Reference Number', sortable: true },
          { key: 'branch', label: 'Branch', sortable: true },
        ],
      },
      {
        id: 'low-stock',
        label: 'Low Stock',
        api: 'lowStock',
        defaultSort: 'product_name',
        columns: [
          { key: 'product', label: 'Product', sortable: true },
          { key: 'available_quantity', label: 'Available Quantity', align: 'right', sortable: true, formatter: formatNumber },
          { key: 'reorder_level', label: 'Reorder Level', align: 'right', sortable: true, formatter: formatNumber },
          { key: 'branch', label: 'Branch', sortable: true },
        ],
      },
      {
        id: 'out-of-stock',
        label: 'Out of Stock',
        api: 'outOfStock',
        defaultSort: 'product',
        columns: [
          { key: 'product', label: 'Product', sortable: true },
          { key: 'category', label: 'Category', sortable: true },
          { key: 'branch', label: 'Branch', sortable: true },
        ],
      },
      {
        id: 'stock-transfers',
        label: 'Stock Transfer',
        api: 'stockTransfers',
        defaultSort: 'transfer_date',
        columns: [
          { key: 'transfer_number', label: 'Transfer Number', sortable: true },
          { key: 'from_branch', label: 'From Branch', sortable: true },
          { key: 'to_branch', label: 'To Branch', sortable: true },
          { key: 'product', label: 'Product', sortable: true },
          { key: 'quantity', label: 'Quantity', align: 'right', sortable: true, formatter: formatNumber },
          { key: 'transfer_date', label: 'Transfer Date', sortable: true, formatter: formatDate },
        ],
      },
    ],
  },
  // {
  //   id: 'tax',
  //   label: 'Tax',
  //   reports: [
  //     {
  //       id: 'daily-tax',
  //       label: 'Daily Tax',
  //       api: 'dailyTax',
  //       defaultSort: 'date',
  //       columns: [
  //         { key: 'date', label: 'Date', sortable: true, formatter: formatDate },
  //         { key: 'taxable_sales', label: 'Taxable Sales', align: 'right', sortable: true, formatter: formatCurrency },
  //         { key: 'tax_amount', label: 'Tax Amount', align: 'right', sortable: true, formatter: formatCurrency },
  //         { key: 'exempt_sales', label: 'Exempt Sales', align: 'right', sortable: true, formatter: formatCurrency },
  //       ],
  //     },
  //     {
  //       id: 'monthly-tax',
  //       label: 'Monthly Tax',
  //       api: 'monthlyTax',
  //       defaultSort: 'month',
  //       columns: [
  //         { key: 'month', label: 'Month', sortable: true },
  //         { key: 'taxable_sales', label: 'Taxable Sales', align: 'right', sortable: true, formatter: formatCurrency },
  //         { key: 'tax_amount', label: 'Tax Amount', align: 'right', sortable: true, formatter: formatCurrency },
  //         { key: 'exempt_sales', label: 'Exempt Sales', align: 'right', sortable: true, formatter: formatCurrency },
  //       ],
  //     },
  //     {
  //       id: 'quarterly-tax',
  //       label: 'Quarterly Tax',
  //       api: 'quarterlyTax',
  //       defaultSort: 'quarter',
  //       columns: [
  //         { key: 'quarter', label: 'Quarter', sortable: true },
  //         { key: 'taxable_sales', label: 'Taxable Sales', align: 'right', sortable: true, formatter: formatCurrency },
  //         { key: 'tax_amount', label: 'Tax Amount', align: 'right', sortable: true, formatter: formatCurrency },
  //         { key: 'exempt_sales', label: 'Exempt Sales', align: 'right', sortable: true, formatter: formatCurrency },
  //       ],
  //     },
  //     {
  //       id: 'gst-summary',
  //       label: 'GST Summary',
  //       api: 'gstSummary',
  //       defaultSort: 'tax_type',
  //       columns: [
  //         { key: 'tax_type', label: 'Tax Type', sortable: true },
  //         { key: 'taxable_amount', label: 'Taxable Amount', align: 'right', sortable: true, formatter: formatCurrency },
  //         { key: 'tax_collected', label: 'Tax Collected', align: 'right', sortable: true, formatter: formatCurrency },
  //       ],
  //     },
  //   ],
  // },
  {
    id: 'financial',
    label: 'Financial',
    reports: [
      {
        id: 'outstanding-receivables',
        label: 'Outstanding Receivables',
        api: 'outstandingReceivables',
        defaultSort: 'due_date',
        columns: [
          { key: 'customer', label: 'Customer', sortable: true },
          { key: 'invoice_number', label: 'Invoice Number', sortable: true },
          { key: 'invoice_date', label: 'Invoice Date', sortable: true, formatter: formatDate },
          { key: 'due_date', label: 'Due Date', sortable: true, formatter: formatDate },
          { key: 'outstanding_amount', label: 'Outstanding Amount', align: 'right', sortable: true, formatter: formatCurrency },
        ],
      },
      {
        id: 'outstanding-payables',
        label: 'Outstanding Payables',
        api: 'outstandingPayables',
        defaultSort: 'due_date',
        columns: [
          { key: 'vendor', label: 'Vendor', sortable: true },
          { key: 'bill_number', label: 'Bill Number', sortable: true },
          { key: 'bill_date', label: 'Bill Date', sortable: true, formatter: formatDate },
          { key: 'due_date', label: 'Due Date', sortable: true, formatter: formatDate },
          { key: 'outstanding_amount', label: 'Outstanding Amount', align: 'right', sortable: true, formatter: formatCurrency },
        ],
      },
      {
        id: 'petty-cash',
        label: 'Petty Cash',
        api: 'pettyCash',
        defaultSort: 'date',
        columns: [
          { key: 'date', label: 'Date', sortable: true, formatter: formatDate },
          { key: 'expense_category', label: 'Expense Category', sortable: true },
          { key: 'description', label: 'Description', sortable: true },
          { key: 'amount', label: 'Amount', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'branch', label: 'Branch', sortable: true },
        ],
      },
    ],
  },
  {
    id: 'customers',
    label: 'Customers',
    reports: [
      {
        id: 'top-customers',
        label: 'Top Customers',
        api: 'topCustomers',
        defaultSort: 'purchase_amount',
        columns: [
          { key: 'customer', label: 'Customer', sortable: true },
          { key: 'invoice_count', label: 'Invoice Count', align: 'right', sortable: true, formatter: formatNumber },
          { key: 'purchase_amount', label: 'Purchase Amount', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'outstanding_amount', label: 'Outstanding Amount', align: 'right', sortable: true, formatter: formatCurrency },
        ],
      },
    ],
  },
  {
    id: 'vendors',
    label: 'Vendors',
    reports: [
      {
        id: 'vendor-outstanding',
        label: 'Vendor Outstanding',
        api: 'vendorOutstanding',
        defaultSort: 'outstanding_amount',
        columns: [
          { key: 'vendor', label: 'Vendor', sortable: true },
          { key: 'purchase_count', label: 'Purchase Count', align: 'right', sortable: true, formatter: formatNumber },
          { key: 'purchase_amount', label: 'Purchase Amount', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'outstanding_amount', label: 'Outstanding Amount', align: 'right', sortable: true, formatter: formatCurrency },
        ],
      },
    ],
  },
]

const REPORT_MAP = REPORT_CATEGORIES.reduce((map, category) => {
  category.reports.forEach((report) => {
    map[report.id] = { ...report, category: category.id }
  })
  return map
}, {})
// Phase 5: stock movement + document trail are wired to live API.
// Sales/purchase register detail tables still use seed data (no paged endpoints yet).

const TABS = [
  { id: 'sales',     label: '📈 Sales Register' },
  { id: 'purchase',  label: '📦 Purchase Register' },
  { id: 'tax',       label: '🧾 Tax Summary (GST)' },
  { id: 'stock',     label: '📊 Stock Movement' },
  { id: 'trail',     label: '🔗 Document Trail' },
  { id: 'branch',    label: '🏪 Branch Comparison' },
  { id: 'margin',    label: '💹 Margin Analysis' },
]

const TRAIL_LABELS = {
  quotation: 'Quotation',
  sales_order: 'Sales Order',
  invoice: 'Invoice',
  credit_note: 'Credit Note',
  customer_payment: 'Customer Payment',
  purchase_order: 'Purchase Order',
  grn: 'GRN',
  purchase_bill: 'Purchase Bill',
  vendor_return: 'Vendor Return',
  vendor_payment: 'Vendor Payment',
}

const TT = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background:'var(--bg-raised)', border:'1px solid var(--border-default)', borderRadius:8, padding:'10px 14px', fontSize:12 }}>
      <div style={{ fontWeight:600, marginBottom:5 }}>{label}</div>
      {payload.map(p => <div key={p.name} style={{ color:p.color }}>
        {p.name}: <span style={{ fontFamily:'DM Mono' }}>{fmt(p.value)}</span>
      </div>)}
    </div>
  )
}

const DEFAULT_CATEGORY = REPORT_CATEGORIES[0].id
const DEFAULT_REPORT = REPORT_CATEGORIES[0].reports[0].id

export default function ReportsPage() {
  const branches = useAppStore((s) => s.branches)
  const today = new Date().toISOString().slice(0, 10)
  const defaultFrom = useMemo(() => {
    const from = new Date()
    from.setDate(from.getDate() - 30)
    return from.toISOString().slice(0, 10)
  }, [])

  const [category, setCategory] = useState(DEFAULT_CATEGORY)
  const [reportType, setReportType] = useState(DEFAULT_REPORT)
  const [dateFrom, setDateFrom] = useState(defaultFrom)
  const [dateTo, setDateTo] = useState(today)
  const [branchId, setBranchId] = useState('')
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState(REPORT_MAP[DEFAULT_REPORT].defaultSort)
  const [sortOrder, setSortOrder] = useState('desc')
  const [skip, setSkip] = useState(0)
  const [limit, setLimit] = useState(50)
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [runKey, setRunKey] = useState(Date.now())
  const [tab, setTab] = useState('sales')

  const selectedReport = REPORT_MAP[reportType]
  const reportOptions = REPORT_CATEGORIES.find((item) => item.id === category)?.reports || []

  const handleCategoryChange = (nextCategory) => {
    const nextReportOptions = REPORT_CATEGORIES.find((item) => item.id === nextCategory)?.reports || []
    const firstReport = nextReportOptions[0]
    setCategory(nextCategory)
    if (firstReport) {
      setReportType(firstReport.id)
      setSortBy(firstReport.defaultSort || firstReport.columns[0]?.key)
      setSortOrder('desc')
      setSkip(0)
      setRunKey(Date.now())
    }
  }

  const handleReportTypeChange = (nextReportType) => {
    const nextReport = REPORT_MAP[nextReportType]
    setReportType(nextReportType)
    if (nextReport) {
      setSortBy(nextReport.defaultSort || nextReport.columns[0]?.key)
      setSortOrder('desc')
      setSkip(0)
      setRunKey(Date.now())
    }
  }
  // Live API data per tab. KPIs render from these; detail tables still use
  // seed (Phase 4 backlog).
  const [salesSummary, setSalesSummary] = useState(null)
  const [purchaseSummary, setPurchaseSummary] = useState(null)
  const [taxSummaryData, setTaxSummary] = useState(null)
  const [branchCompare, setBranchCompare] = useState([])
  const [marginData, setMarginData] = useState(null)
  const [stockData, setStockData] = useState(null)
  const [trailNumber, setTrailNumber] = useState('')
  const [trailResult, setTrailResult] = useState(null)
  const [trailLoading, setTrailLoading] = useState(false)

  useEffect(() => {
    if (!selectedReport) return

    const fetchData = async () => {
      setLoading(true)
      try {
        const params = {
          branch_id: branchId || undefined,
          date_from: dateFrom,
          date_to: dateTo,
          search: search || undefined,
          sort_by: sortBy,
          sort_order: sortOrder,
          skip,
          limit,
        }
        const response = await reportsAPI[selectedReport.api](params)
        const payload = response?.data ?? response
        const data = payload.items ?? payload
        setRows(Array.isArray(data) ? data : [])
        setTotal(typeof payload.total === 'number' ? payload.total : Array.isArray(data) ? data.length : 0)
      } catch (error) {
        console.error(error)
        setRows([])
        setTotal(0)
      } finally {
        setLoading(false)
        try {
          const [s, p, t, b, m, stk] = await Promise.all([
            reportsAPI.salesSummary(params).catch(() => null),
            reportsAPI.purchaseSummary(params).catch(() => null),
            reportsAPI.taxSummary({ date_from: dateFrom, date_to: dateTo }).catch(() => null),
            reportsAPI.branchCompare().catch(() => []),
            reportsAPI.marginAnalysis().catch(() => null),
            reportsAPI.stockMovement({
              branch_id: branchId || undefined,
              date_from: dateFrom,
              date_to: dateTo,
              limit: 500,
            }).catch(() => null),
          ])
          if (cancelled) return
          setSalesSummary(s)
          setPurchaseSummary(p)
          setTaxSummary(t)
          setBranchCompare(Array.isArray(b) ? b : [])
          setMarginData(m)
          setStockData(stk)
        } catch (e) {
          // Toast already fired by axios interceptor.
          console.error(e)
        }
      }
    }

    fetchData()
  }, [selectedReport, branchId, dateFrom, dateTo, search, sortBy, sortOrder, skip, limit, runKey])
  // Helpers — fall back to seed-derived numbers when the API hasn't replied
  // yet, so the page stays usable on first paint.
  const seedSalesTotal = useMemo(() => SALES_INVOICES.reduce((s, i) => s + i.total, 0), [])
  const seedPurchaseTotal = useMemo(() => PURCHASE_BILLS.reduce((s, b) => s + b.total, 0), [])
  const seedSalesCount = SALES_INVOICES.length
  const seedPurchaseCount = PURCHASE_BILLS.length
  const stockRows = stockData?.items ?? []

  const handleTrailSearch = async () => {
    const num = trailNumber.trim()
    if (!num) {
      toast.error('Enter a document number (e.g. INV-2026-2001)')
      return
    }
    setTrailLoading(true)
    try {
      const res = await reportsAPI.documentTrail({ number: num })
      setTrailResult(res)
    } catch {
      setTrailResult(null)
    } finally {
      setTrailLoading(false)
    }
  }

  const handleGenerate = () => {
    if (!dateFrom || !dateTo) {
      toast.error('Please select both dates.')
      return
    }
    if (new Date(dateTo) < new Date(dateFrom)) {
      toast.error('End date must be after start date.')
      return
    }
    setSkip(0)
    setRunKey(Date.now())
  }

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
      selectedReport.columns.forEach((col) => {
        const value = row[col.key]
        entry[col.label] = value === null || value === undefined ? '' : value
      })
      return entry
    })

    exportToExcel(exportData, `${selectedReport.label.replace(/\s+/g, '_')}_${dateFrom}_to_${dateTo}.xlsx`)
    toast.success('Excel export ready')
  }

  const exportPdf = () => {
    window.print()
  }

  const printReport = () => {
    window.print()
  }

  return (
    <div className="page-container">
      <SectionHeader/>

      <div style={{ marginBottom: 18, display: 'grid', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(160px, 1fr))', gap: 12, alignItems: 'end' }}>
          <div>
            <label className="form-label">From</label>
            <input className="form-input" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </div>
          <div>
            <label className="form-label">To</label>
            <input className="form-input" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </div>
          <div>
            <label className="form-label">Branch</label>
            <select className="form-input" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">All Branches</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>{branch.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="form-label">Report</label>
            <select className="form-input" value={reportType} onChange={(e) => handleReportTypeChange(e.target.value)}>
              {reportOptions.map((report) => (
                <option key={report.id} value={report.id}>{report.label}</option>
              ))}
            </select>
          </div>
          {/* <button className="btn btn-primary" style={{ height: 40, marginTop: 6 }} onClick={handleGenerate}>Generate</button> */}
          <button className="btn btn-secondary" style={{ height: 40, marginTop: 6 }} onClick={exportExcel}>Export Excel</button>
          {/* <button className="btn btn-secondary" style={{ height: 40, marginTop: 6 }} onClick={exportPdf}>Export PDF</button> */}
        </div>
        <div>
          <SearchBar value={search} onChange={setSearch} placeholder="Search invoices, products, customers…" style={{ width: '100%' }} />
        </div>
      </div>

<Tabs tabs={REPORT_CATEGORIES.map((item) => ({ id: item.id, label: item.label }))} active={category} onChange={handleCategoryChange} />

      <Card title={selectedReport ? selectedReport.label : 'Report'} titleRight={<div style={{ display: 'flex', gap: 8 }}>
        {/* <button className="btn btn-secondary btn-sm" onClick={printReport}>Print</button> */}
      </div>} bodyPadding={false}>
        <div style={{ padding: 16, overflowX: 'auto' }}>
          <table className="data-table" style={{ minWidth: 920 }}>
            <thead>
              <tr>
                {selectedReport.columns.map((column) => (
                  <SortableHeader
                    key={column.key}
                    label={column.label}
                    sortKey={column.key}
                    sortBy={sortBy}
                    sortOrder={sortOrder}
                    onSort={handleSort}
                    align={column.align || 'left'}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={selectedReport.columns.length} style={{ textAlign: 'center', padding: 28 }}>Loading report data…</td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={selectedReport.columns.length} style={{ textAlign: 'center', padding: 28 }}>No records match the selected filters.</td>
                </tr>
              ) : (
                rows.map((row, index) => (
                  <tr key={index}>
                    {selectedReport.columns.map((column) => {
                      const value = row[column.key]
                      const rendered = column.formatter ? column.formatter(value, row) : value
                      return (
                        <td key={column.key} className={column.align === 'right' ? 'text-right' : ''}>
                          {rendered !== null && rendered !== undefined ? rendered : '—'}
                        </td>
                      )
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
      {/* ── STOCK MOVEMENT ──────────────────────────────────────── */}
      {tab === 'stock' && (
        <Card title={`Stock Movement Report — ${dateFrom} to ${dateTo}`} titleRight={
          <button className="btn btn-secondary btn-sm" onClick={() => {
            const exportData = stockRows.map(r => ({
              'Item': r.item_name,
              'SKU': r.sku,
              'Opening Stock': r.opening,
              'Purchased': r.purchases_in,
              'Sold': r.sales_out,
              'Transferred': r.transfers_net,
              'Adjusted': r.adjustments,
              'Closing Stock': r.closing,
              'Variance': r.variance,
            }))
            exportToCSV(exportData, `Stock_Movement_${dateFrom}_to_${dateTo}.csv`)
            toast.success('Stock movement report exported')
          }}>↓ Export</button>
        } bodyPadding={false}>
          {stockRows.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              {stockData ? 'No stock movement in this period.' : 'Click Generate to load stock data.'}
            </div>
          ) : (
            <table className="data-table">
              <thead><tr><th>Item</th><th className="text-right">Opening</th><th className="text-right">Purchased</th><th className="text-right">Sold</th><th className="text-right">Transferred</th><th className="text-right">Adjusted</th><th className="text-right">Closing</th><th>Variance</th></tr></thead>
              <tbody>
                {stockRows.map(r => {
                  const trans = r.transfers_net ?? ((r.transfers_in || 0) - (r.transfers_out || 0))
                  const expected = r.opening + r.purchases_in - r.sales_out + trans
                  const variance = r.variance ?? (r.closing - expected)
                  return (
                    <tr key={r.item_id || r.sku}>
                      <td><div><div style={{fontWeight:500,color:'var(--text-primary)',fontSize:12.5}}>{r.item_name}</div><div style={{fontSize:11,color:'var(--text-muted)'}}>{r.sku}</div></div></td>
                      <td className="text-right mono">{r.opening}</td>
                      <td className="text-right mono" style={{color: r.purchases_in >= 0 ? 'var(--green)' : 'var(--red)'}}>{r.purchases_in >= 0 ? '+' : ''}{r.purchases_in}</td>
                      <td className="text-right mono" style={{color:'var(--red)'}}>-{r.sales_out}</td>
                      <td className="text-right mono" style={{color:'var(--blue)'}}>{trans >= 0 ? '+' : ''}{trans}</td>
                      <td className="text-right mono">{r.adjustments >= 0 ? '+' : ''}{r.adjustments}</td>
                      <td className="text-right mono" style={{fontWeight:600,color:'var(--text-primary)'}}>{r.closing}</td>
                      <td><span style={{fontSize:11.5,padding:'2px 8px',borderRadius:10,background:variance===0?'var(--green-bg)':variance>0?'var(--blue-bg)':'var(--red-bg)',color:variance===0?'var(--green)':variance>0?'var(--blue)':'var(--red)',fontWeight:600}}>{variance===0?'Match':variance>0?'+'+variance:variance}</span></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {/* ── DOCUMENT TRAIL ──────────────────────────────────────── */}
      {tab === 'trail' && (
        <>
          <Card title="Document Lineage Search">
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="text"
                className="form-input"
                placeholder="Document number (QT-, SO-, INV-, CN-, PO-, GRN-, PUR-, RET-)"
                value={trailNumber}
                onChange={e => setTrailNumber(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleTrailSearch()}
                style={{ flex: 1, minWidth: 280 }}
              />
              <button className="btn btn-primary btn-sm" onClick={handleTrailSearch} disabled={trailLoading}>
                {trailLoading ? 'Searching…' : 'Trace'}
              </button>
            </div>
            <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
              Traces upstream and downstream links: Quote → SO → Invoice → Credit Note, or PO → GRN → Bill → Vendor Return.
            </p>
          </Card>

          {trailResult?.chain?.length > 0 && (
            <Card title={`Trail for ${trailResult.number}`} bodyPadding={false}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Step</th>
                    <th>Type</th>
                    <th>Number</th>
                    <th>Date</th>
                    <th>Status</th>
                    <th className="text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {trailResult.chain.map((node, i) => (
                    <tr key={`${node.type}-${node.id}`}>
                      <td className="mono" style={{ color: 'var(--text-muted)' }}>{i + 1}</td>
                      <td>{TRAIL_LABELS[node.type] || node.type}</td>
                      <td style={{ fontWeight: 500 }}>{node.number}</td>
                      <td>{node.date || '—'}</td>
                      <td><Chip label={node.status} custom={{ bg: 'var(--bg-raised)', color: 'var(--text-secondary)' }} /></td>
                      <td className="text-right mono">{fmt(node.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}

      {/* ── BRANCH COMPARISON ───────────────────────────────────── */}
      {tab === 'branch' && (
        <>
          <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:14,marginBottom:20}}>
            {(branchCompare.length > 0
              ? branchCompare.map((b, i) => ({
                  name: b.branch,
                  sales: b.sales,
                  purchases: b.purchases,
                  color: ['#6366f1','#a78bfa','#2dd4bf','#f5a623','#22c97a','#f5485c'][i % 6],
                }))
              : [
                  {name:'Male',      sales:1480000, purchases:840000, color:'#6366f1'},
                  {name:'Addu',      sales:1120000, purchases:620000, color:'#a78bfa'},
                  {name:'Hulhumalé', sales:860000,  purchases:480000, color:'#2dd4bf'},
                  {name:'Felidhoo',  sales:540000,  purchases:310000, color:'#f5a623'},
                ]
            ).map(b=>(
              <div key={b.name} style={{background:'var(--bg-surface)',border:'1px solid var(--border-default)',borderRadius:14,padding:18}}>
                <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:14}}>
                  <span style={{width:10,height:10,borderRadius:'50%',background:b.color,display:'inline-block'}}/>
                  <span style={{fontWeight:600,fontSize:14}}>{b.name}</span>
                </div>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:12}}>
                  <div><div style={{fontSize:11,color:'var(--text-muted)'}}>Sales (Apr)</div><div style={{fontSize:16,fontWeight:700,color:'var(--text-primary)'}}>{fmt(b.sales)}</div></div>
                  <div><div style={{fontSize:11,color:'var(--text-muted)'}}>Purchases</div><div style={{fontSize:15,fontWeight:600,color:'var(--text-secondary)'}}>{fmt(b.purchases)}</div></div>
                </div>
                <div style={{fontSize:11,color:'var(--text-muted)',marginBottom:4}}>Performance vs Male</div>
                <div style={{height:6,background:'var(--bg-hover)',borderRadius:3,overflow:'hidden'}}>
                  <div style={{height:'100%',borderRadius:3,background:b.color,width:`${Math.round(b.sales/14800)}%`,transition:'width 1s ease'}}/>
                </div>
              </div>
            ))}
          </div>
          <Card title="Branch Sales Comparison Chart">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={SALES_TREND.slice(-7).map(d=>({...d,tnagar:Math.round(d.sales*0.76),vadapalani:Math.round(d.sales*0.55),velachery:Math.round(d.sales*0.35)}))} margin={{top:5,right:10,left:-10,bottom:0}}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)"/>
                <XAxis dataKey="date" tick={{fontSize:10,fill:'var(--text-muted)'}} tickLine={false} axisLine={false}/>
                <YAxis tick={{fontSize:10,fill:'var(--text-muted)'}} tickLine={false} axisLine={false} tickFormatter={v=>`₹${(v/1000).toFixed(0)}K`}/>
                <Tooltip content={<TT/>}/>
                <Legend wrapperStyle={{fontSize:11,color:'var(--text-muted)'}}/>
                <Bar dataKey="sales"     name="Male"      fill="#6366f1" radius={[3,3,0,0]}/>
                <Bar dataKey="tnagar"    name="Addu"      fill="#a78bfa" radius={[3,3,0,0]}/>
                <Bar dataKey="vadapalani" name="Hulhumalé" fill="#2dd4bf" radius={[3,3,0,0]}/>
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </>
      )}

      <div style={{ marginTop: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          Showing {rows.length} of {total} record{total === 1 ? '' : 's'}.
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
    </div>
  )
}