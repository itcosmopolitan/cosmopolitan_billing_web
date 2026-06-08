
import { useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { reportsAPI } from '@/api'
import { useAppStore } from '@/store'
import { fmt, fmtDate, fmtNum, exportToCSV } from '@/utils/helpers'
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
        defaultSort: 'date',
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
  {
    id: 'tax',
    label: 'Tax',
    reports: [
      {
        id: 'daily-tax',
        label: 'Daily Tax',
        api: 'dailyTax',
        defaultSort: 'date',
        columns: [
          { key: 'date', label: 'Date', sortable: true, formatter: formatDate },
          { key: 'taxable_sales', label: 'Taxable Sales', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'tax_amount', label: 'Tax Amount', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'exempt_sales', label: 'Exempt Sales', align: 'right', sortable: true, formatter: formatCurrency },
        ],
      },
      {
        id: 'monthly-tax',
        label: 'Monthly Tax',
        api: 'monthlyTax',
        defaultSort: 'month',
        columns: [
          { key: 'month', label: 'Month', sortable: true },
          { key: 'taxable_sales', label: 'Taxable Sales', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'tax_amount', label: 'Tax Amount', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'exempt_sales', label: 'Exempt Sales', align: 'right', sortable: true, formatter: formatCurrency },
        ],
      },
      {
        id: 'quarterly-tax',
        label: 'Quarterly Tax',
        api: 'quarterlyTax',
        defaultSort: 'quarter',
        columns: [
          { key: 'quarter', label: 'Quarter', sortable: true },
          { key: 'taxable_sales', label: 'Taxable Sales', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'tax_amount', label: 'Tax Amount', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'exempt_sales', label: 'Exempt Sales', align: 'right', sortable: true, formatter: formatCurrency },
        ],
      },
      {
        id: 'gst-summary',
        label: 'GST Summary',
        api: 'gstSummary',
        defaultSort: 'tax_type',
        columns: [
          { key: 'tax_type', label: 'Tax Type', sortable: true },
          { key: 'taxable_amount', label: 'Taxable Amount', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'tax_collected', label: 'Tax Collected', align: 'right', sortable: true, formatter: formatCurrency },
        ],
      },
    ],
  },
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

  const selectedReport = REPORT_MAP[reportType]
  const reportOptions = REPORT_CATEGORIES.find((item) => item.id === category)?.reports || []

  useEffect(() => {
    if (!reportOptions.some((report) => report.id === reportType)) {
      const firstReport = reportOptions[0]
      if (firstReport) {
        setReportType(firstReport.id)
        setSortBy(firstReport.defaultSort || firstReport.columns[0]?.key)
        setSortOrder('desc')
        setSkip(0)
      }
    }
  }, [category])

  useEffect(() => {
    if (!selectedReport) return
    setSortBy(selectedReport.defaultSort || selectedReport.columns[0]?.key)
    setSortOrder('desc')
    setSkip(0)
    setRunKey(Date.now())
  }, [reportType])

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
      }
    }

    fetchData()
  }, [selectedReport, branchId, dateFrom, dateTo, search, sortBy, sortOrder, skip, limit, runKey])

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

  const exportCsv = () => {
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
    exportToCSV(exportData, `${selectedReport.label.replace(/\s+/g, '_')}_${dateFrom}_to_${dateTo}.csv`)
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
            <select className="form-input" value={reportType} onChange={(e) => setReportType(e.target.value)}>
              {reportOptions.map((report) => (
                <option key={report.id} value={report.id}>{report.label}</option>
              ))}
            </select>
          </div>
          <button className="btn btn-primary" style={{ height: 40, marginTop: 6 }} onClick={handleGenerate}>Generate</button>
          <button className="btn btn-secondary" style={{ height: 40, marginTop: 6 }} onClick={exportCsv}>Export Excel</button>
          <button className="btn btn-secondary" style={{ height: 40, marginTop: 6 }} onClick={exportPdf}>Export PDF</button>
        </div>
        <div>
          <SearchBar value={search} onChange={setSearch} placeholder="Search invoices, products, customers…" style={{ width: '100%' }} />
        </div>
      </div>

      <Tabs tabs={REPORT_CATEGORIES.map((item) => ({ id: item.id, label: item.label }))} active={category} onChange={setCategory} />

      <Card title={selectedReport ? selectedReport.label : 'Report'} titleRight={<div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-secondary btn-sm" onClick={printReport}>Print</button>
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
