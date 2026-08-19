
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { reportsAPI, AUTOCOMPLETE_BRANCH_URL } from '@/api'
import { fmt, fmtDate, fmtNum, fmtQty, exportToExcel } from '@/utils/helpers'
import { SectionHeader, Card, SearchBar, PaginationBar, SortableHeader, AutocompleteDropdown, DatePicker, TableLoadingPanel, PageActionsMenu, buildListPageMenuActions } from '@/components/ui'

const formatDate = (value) => (value ? fmtDate(value) : '—')
const formatCurrency = (value) => (value === null || value === undefined ? '—' : fmt(value))
const formatNumber = (value) => (value === null || value === undefined ? '—' : fmtNum(value))
const formatQty = (value) => (value === null || value === undefined ? '—' : fmtQty(value))

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
        getDetailPath: (row) => (row.invoice_id ? `/sales?tab=invoices&view=${encodeURIComponent(row.invoice_id)}` : null),
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
          { key: 'quantity_sold', label: 'Quantity Sold', align: 'right', sortable: true, formatter: formatQty },
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
          { key: 'quantity_sold', label: 'Quantity Sold', align: 'right', sortable: true, formatter: formatQty },
          { key: 'sales_value', label: 'Sales Value', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'cost_value', label: 'Cost Value', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'profit', label: 'Profit', align: 'right', sortable: true, formatter: formatCurrency },
        ],
      },
      {
        id: 'payment-sales',
        label: 'Payment Method Sales',
        api: 'paymentSales',
        defaultSort: 'sales_amount',
        columns: [
          { key: 'payment_method', label: 'Payment Method', sortable: true },
          { key: 'invoice_count', label: 'Invoice Count', align: 'right', sortable: true, formatter: formatNumber },
          { key: 'quantity_sold', label: 'Quantity Sold', align: 'right', sortable: true, formatter: formatQty },
          { key: 'sales_amount', label: 'Sales Amount', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'tax_amount', label: 'Tax Amount', align: 'right', sortable: true, formatter: formatCurrency },
          { key: 'net_sales', label: 'Net Sales', align: 'right', sortable: true, formatter: formatCurrency },
        ],
      },
      {
        id: 'category-sales',
        label: 'Category-wise Sales',
        api: 'categorySales',
        defaultSort: 'sales_value',
        columns: [
          { key: 'category', label: 'Category', sortable: true },
          { key: 'quantity_sold', label: 'Quantity Sold', align: 'right', sortable: true, formatter: formatQty },
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
        getDetailPath: (row) => (row.bill_id ? `/purchases?tab=bills&view=${encodeURIComponent(row.bill_id)}` : null),
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
          { key: 'quantity_purchased', label: 'Quantity Purchased', align: 'right', sortable: true, formatter: formatQty },
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
          { key: 'available_stock', label: 'Available Stock', align: 'right', sortable: true, formatter: formatQty },
          { key: 'reserved_stock', label: 'Reserved Stock', align: 'right', sortable: true, formatter: formatQty },
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
          { key: 'quantity', label: 'Quantity', align: 'right', sortable: true, formatter: formatQty },
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
          { key: 'available_quantity', label: 'Available Quantity', align: 'right', sortable: true, formatter: formatQty },
          { key: 'reorder_level', label: 'Reorder Level', align: 'right', sortable: true, formatter: formatQty },
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
        getDetailPath: (row) => (row.transfer_id ? `/transfers/${encodeURIComponent(row.transfer_id)}/edit` : null),
        columns: [
          { key: 'transfer_number', label: 'Transfer Number', sortable: true },
          { key: 'from_branch', label: 'From Branch', sortable: true },
          { key: 'to_branch', label: 'To Branch', sortable: true },
          { key: 'product', label: 'Product', sortable: true },
          { key: 'quantity', label: 'Quantity', align: 'right', sortable: true, formatter: formatQty },
          { key: 'transfer_date', label: 'Transfer Date', sortable: true, formatter: formatDate },
        ],
      },
      {
        id: 'spoilage-damage',
        label: 'Spoilage / Damage',
        api: 'spoilageDamage',
        defaultSort: 'date',
        columns: [
          { key: 'date', label: 'Date', sortable: true, formatter: formatDate },
          { key: 'reference_number', label: 'Reference', sortable: true },
          { key: 'product_code', label: 'Product Code', sortable: true },
          { key: 'product', label: 'Product', sortable: true },
          { key: 'branch', label: 'Branch', sortable: true },
          { key: 'before_qty', label: 'Before Qty', align: 'right', sortable: true, formatter: formatQty },
          { key: 'after_qty', label: 'After Qty', align: 'right', sortable: true, formatter: formatQty },
          { key: 'quantity_lost', label: 'Qty Lost', align: 'right', sortable: true, formatter: formatQty },
          { key: 'reason', label: 'Reason', sortable: true },
          { key: 'notes', label: 'Notes', sortable: false },
          { key: 'adjusted_by', label: 'Adjusted By', sortable: true },
        ],
      },
      {
        id: 'expiry-batches',
        label: 'Expired / Near Expiry',
        api: 'expiryBatches',
        defaultSort: 'expiry_date',
        columns: [
          { key: 'product_code', label: 'Product Code', sortable: true },
          { key: 'product', label: 'Product', sortable: true },
          { key: 'batch_number', label: 'Batch', sortable: true },
          { key: 'branch', label: 'Branch', sortable: true },
          { key: 'mfg_date', label: 'Mfg Date', sortable: true, formatter: formatDate },
          { key: 'expiry_date', label: 'Expiry Date', sortable: true, formatter: formatDate },
          { key: 'days_to_expiry', label: 'Days Left', align: 'right', sortable: false, formatter: formatNumber },
          { key: 'status', label: 'Status', sortable: true },
          { key: 'quantity', label: 'Qty On Hand', align: 'right', sortable: true, formatter: formatQty },
          { key: 'stock_value', label: 'Stock Value', align: 'right', sortable: true, formatter: formatCurrency },
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
        getDetailPath: (row) => (row.invoice_id ? `/sales?tab=invoices&view=${encodeURIComponent(row.invoice_id)}` : null),
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
        getDetailPath: (row) => (row.bill_id ? `/purchases?tab=bills&view=${encodeURIComponent(row.bill_id)}` : null),
        columns: [
          { key: 'vendor', label: 'Vendor', sortable: true },
          { key: 'bill_number', label: 'Bill Number', sortable: true },
          { key: 'bill_date', label: 'Bill Date', sortable: true, formatter: formatDate },
          { key: 'due_date', label: 'Due Date', sortable: true, formatter: formatDate },
          { key: 'outstanding_amount', label: 'Outstanding Amount', align: 'right', sortable: true, formatter: formatCurrency },
        ],
      },
      {
        id: 'profit-loss',
        label: 'Profit & Loss',
        api: 'profitLoss',
        defaultSort: 'sort_order',
        columns: [
          { key: 'account', label: 'ACCOUNT', sortable: false },
          {
            key: 'total',
            label: 'TOTAL',
            align: 'right',
            sortable: false,
            formatter: (value) => (value === null || value === undefined ? '' : formatCurrency(value)),
          },
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
    map[report.id] = { ...report, categoryId: category.id, categoryLabel: category.label }
  })
  return map
}, {})

export default function ReportsPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const reportId = searchParams.get('report') || ''
  const reportGroup = searchParams.get('report_group') || ''
  const selectedReport = REPORT_MAP[reportId] || null
  const listPath = reportGroup
    ? `/reports?report_group=${encodeURIComponent(reportGroup)}`
    : '/reports'

  if (reportId && !selectedReport) {
    return <NavigateToReportsList />
  }

  if (!selectedReport) {
    return (
      <ReportsListPage
        reportGroup={reportGroup}
        onSelectGroup={(id) => navigate(`/reports?report_group=${encodeURIComponent(id)}`)}
        onOpen={(id) => {
          const params = new URLSearchParams()
          params.set('report', id)
          if (reportGroup) params.set('report_group', reportGroup)
          else params.set('report_group', REPORT_MAP[id]?.categoryId || '')
          navigate(`/reports?${params.toString()}`)
        }}
      />
    )
  }

  return <ReportDetailPage report={selectedReport} onBack={() => navigate(listPath)} />
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

function ReportsListPage({ reportGroup, onSelectGroup, onOpen }) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()

  const activeGroupId = REPORT_CATEGORIES.some((c) => c.id === reportGroup)
    ? reportGroup
    : REPORT_CATEGORIES[0].id
  const activeCategory = REPORT_CATEGORIES.find((c) => c.id === activeGroupId) || REPORT_CATEGORIES[0]

  const visibleReports = (activeCategory.reports || []).filter((report) => (
    !needle || report.label.toLowerCase().includes(needle) || activeCategory.label.toLowerCase().includes(needle)
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
          {REPORT_CATEGORIES.map((category) => {
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
                <span style={{ display: 'inline-flex', opacity: 0.85 }}><FolderIcon /></span>
                {category.label}
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
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{activeCategory.label}</h2>
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
              </tr>
            </thead>
            <tbody>
              {visibleReports.length === 0 ? (
                <tr>
                  <td style={{ textAlign: 'center', padding: 28, color: 'var(--text-muted)' }}>
                    No reports match that search.
                  </td>
                </tr>
              ) : visibleReports.map((report) => (
                  <tr key={report.id} style={{ cursor: 'pointer' }} onClick={() => onOpen(report.id)}>
                    <td>
                      <span style={{ color: 'var(--blue)', fontWeight: 500 }}>{report.label}</span>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  )
}

function ReportDetailPage({ report, onBack }) {
  const navigate = useNavigate()
  const today = new Date().toISOString().slice(0, 10)
  const defaultFrom = useMemo(() => {
    const from = new Date()
    from.setDate(from.getDate() - 30)
    return from.toISOString().slice(0, 10)
  }, [])

  const [dateFrom, setDateFrom] = useState(defaultFrom)
  const [dateTo, setDateTo] = useState(today)
  const [branchId, setBranchId] = useState('')
  const [sortBy, setSortBy] = useState(report.defaultSort || report.columns[0]?.key)
  const [sortOrder, setSortOrder] = useState('desc')
  const [skip, setSkip] = useState(0)
  const [limit, setLimit] = useState(50)
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [runKey, setRunKey] = useState(Date.now())

  useEffect(() => {
    setSortBy(report.defaultSort || report.columns[0]?.key)
    setSortOrder('desc')
    setSkip(0)
    setRows([])
    setTotal(0)
    setRunKey(Date.now())
  }, [report.id, report.defaultSort, report.columns])

  useEffect(() => {
    let cancelled = false
    const fetchData = async () => {
      setLoading(true)
      try {
        const params = {
          branch_id: branchId ? branchId : null,
          date_from: dateFrom,
          date_to: dateTo,
          sort_by: sortBy,
          sort_order: sortOrder,
          skip,
          limit: report.id === 'profit-loss' ? Math.max(limit, 100) : limit,
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
  }, [report, branchId, dateFrom, dateTo, sortBy, sortOrder, skip, limit, runKey])

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
      report.columns.forEach((col) => {
        const value = row[col.key]
        entry[col.label] = value === null || value === undefined ? '' : value
      })
      return entry
    })
    exportToExcel(exportData, `${report.label.replace(/\s+/g, '_')}_${dateFrom}_to_${dateTo}.xlsx`)
    toast.success('Excel export ready')
  }

  return (
    <div className="page-container">
      <SectionHeader
        title={report.label}
        subtitle={`${report.categoryLabel} report`}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" className="btn btn-secondary" onClick={onBack}>Back to reports</button>
          <PageActionsMenu actions={buildListPageMenuActions({
            onExport: exportExcel,
            onRefresh: () => {
              setSkip(0)
              setRunKey(Date.now())
              toast.success('Report refreshed')
            },
          })} />
        </div>
      </SectionHeader>

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
              onChange={setBranchId}
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
                {report.columns.map((column) => (
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
                  <td colSpan={report.columns.length} style={{ padding: 0 }}>
                    <TableLoadingPanel label="Loading report data…" />
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={report.columns.length} style={{ textAlign: 'center', padding: 28 }}>No records match the selected filters.</td>
                </tr>
              ) : (
                rows.map((row, index) => {
                  const isPnL = report.id === 'profit-loss'
                  const emphasis = isPnL && (row.row_type === 'header' || row.row_type === 'section_total' || row.row_type === 'result')
                  const detailPath = typeof report.getDetailPath === 'function' ? report.getDetailPath(row) : null
                  const rowStyle = isPnL
                    ? {
                        fontWeight: emphasis ? 700 : 400,
                        background: row.row_type === 'result' ? 'var(--bg-subtle, rgba(0,0,0,0.03))' : undefined,
                      }
                    : detailPath
                      ? { cursor: 'pointer' }
                      : undefined
                  return (
                    <tr
                      key={index}
                      style={rowStyle}
                      onClick={detailPath ? () => navigate(detailPath) : undefined}
                    >
                      {report.columns.map((column) => {
                        const value = row[column.key]
                        const rendered = column.formatter ? column.formatter(value, row) : value
                        const alignClass =
                          column.align === 'right' ? 'text-right' : column.align === 'center' ? 'text-center' : ''
                        const isNameCol = ['invoice_number', 'bill_number', 'transfer_number'].includes(column.key)
                        return (
                          <td
                            key={column.key}
                            className={alignClass}
                            style={{
                              ...(isPnL && column.key === 'account' && row.row_type === 'detail' ? { paddingLeft: 28 } : {}),
                              ...(detailPath && isNameCol ? { color: 'var(--blue)', fontWeight: 500 } : {}),
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

