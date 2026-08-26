import { useEffect, useMemo, useState } from 'react'
import {
  AUTOCOMPLETE_CUSTOMER_URL,
  AUTOCOMPLETE_CATEGORY_URL,
  AUTOCOMPLETE_VENDOR_URL,
} from '@/api'
import {
  AutocompleteDropdown,
  DatePicker,
  Drawer,
  FormGroup,
  SearchBar,
} from '@/components/ui'
import * as Icon from '@/components/ui/Icons'
import {
  PAYMENT_METHOD_WITH_CREDIT_OPTIONS,
  statusOptions as defaultStatusOptions,
} from '@/utils/dropdownOptions'

export const EMPTY_LIST_FILTERS = {
  status: '',
  paymentMode: '',
  customerId: '',
  customerLabel: '',
  vendorId: '',
  vendorLabel: '',
  categoryId: '',
  categoryLabel: '',
  discount: '',
  dateFrom: '',
  dateTo: '',
}

/** @deprecated use EMPTY_LIST_FILTERS */
export const EMPTY_SALES_LIST_FILTERS = EMPTY_LIST_FILTERS
/** @deprecated use EMPTY_LIST_FILTERS */
export const EMPTY_INVOICE_FILTERS = EMPTY_LIST_FILTERS

const INVOICE_STATUS_OPTIONS = defaultStatusOptions(['paid', 'pending', 'partial', 'overdue', 'draft', 'pending_approval'])
const DISCOUNT_OPTIONS = [
  { id: '', label: 'All' },
  { id: 'with', label: 'With discount' },
  { id: 'without', label: 'Without discount' },
]

function optionLabel(options, id, fallback) {
  if (!id) return ''
  return options.find((o) => o.id === id)?.label || fallback || id
}

function buildChips(filters, fieldSet, statusOpts) {
  const chips = []
  if (fieldSet.has('customer') && filters.customerId) {
    chips.push({
      key: 'customer',
      label: `Customer is ${filters.customerLabel || filters.customerId}`,
    })
  }
  if (fieldSet.has('vendor') && filters.vendorId) {
    chips.push({
      key: 'vendor',
      label: `Vendor is ${filters.vendorLabel || filters.vendorId}`,
    })
  }
  if (fieldSet.has('status') && filters.status) {
    chips.push({
      key: 'status',
      label: `Status is ${optionLabel(statusOpts, filters.status)}`,
    })
  }
  if (fieldSet.has('paymentMode') && filters.paymentMode) {
    chips.push({
      key: 'paymentMode',
      label: `Payment method is ${optionLabel(PAYMENT_METHOD_WITH_CREDIT_OPTIONS, filters.paymentMode)}`,
    })
  }
  if (fieldSet.has('category') && filters.categoryId) {
    chips.push({
      key: 'category',
      label: `Category is ${filters.categoryLabel || filters.categoryId}`,
    })
  }
  if (fieldSet.has('discount') && filters.discount) {
    chips.push({
      key: 'discount',
      label: `Discount is ${optionLabel(DISCOUNT_OPTIONS, filters.discount)}`,
    })
  }
  if (fieldSet.has('date') && (filters.dateFrom || filters.dateTo)) {
    const from = filters.dateFrom || '…'
    const to = filters.dateTo || '…'
    chips.push({ key: 'date', label: `Date between ${from} and ${to}` })
  }
  return chips
}

/**
 * Shared sales/purchase list filter UI: live search + New/more + filter icon;
 * sidebar Apply shows an applied-band below the toolbar.
 *
 * `fields` controls which sidebar filters render.
 */
export default function ListFilters({
  search = '',
  onSearchChange,
  searchPlaceholder = 'Search…',
  filters,
  onApply,
  onClear,
  onRemoveChip,
  toolbarActions = null,
  fields = ['status', 'date'],
  statusOptions: statusOpts = INVOICE_STATUS_OPTIONS,
}) {
  const fieldSet = useMemo(() => new Set(fields), [fields])
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(filters)

  useEffect(() => {
    if (open) setDraft(filters)
  }, [open, filters])

  const chips = useMemo(
    () => buildChips(filters, fieldSet, statusOpts),
    [filters, fieldSet, statusOpts],
  )
  const activeCount = chips.length
  const filtersActive = activeCount > 0

  const setDraftField = (key, value) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const handleApply = () => {
    onApply({ ...draft })
    setOpen(false)
  }

  const handleClearInDrawer = () => {
    setDraft({ ...EMPTY_LIST_FILTERS })
    onClear()
    setOpen(false)
  }

  const handleClearAll = () => {
    onClear()
    setDraft({ ...EMPTY_LIST_FILTERS })
    setOpen(false)
  }

  return (
    <>
      <div className="filter-toolbar-stack">
        <div className="filter-toolbar">
          <SearchBar
            value={search}
            onChange={onSearchChange}
            placeholder={searchPlaceholder}
            style={{ flex: 1, minWidth: 200, maxWidth: 420 }}
          />
          <div className="filter-toolbar__actions">
            {toolbarActions}
            <button
              type="button"
              className={`filter-trigger${filtersActive ? ' is-active' : ''}`}
              aria-label="Open filters"
              title="Filters"
              onClick={() => setOpen(true)}
            >
              <Icon.Filter size={18} />
              {filtersActive && (
                <span className="filter-trigger__badge">{activeCount}</span>
              )}
            </button>
          </div>
        </div>
        {filtersActive && (
          <div className="filter-applied-band" role="status" aria-label="Applied filters">
            <span className="filter-applied-band__label">Filter:</span>
            {chips.map((chip) => (
              <span key={chip.key} className="filter-applied-chip">
                <span className="filter-applied-chip__text" title={chip.label}>{chip.label}</span>
                <button
                  type="button"
                  className="filter-applied-chip__remove"
                  aria-label={`Remove ${chip.label}`}
                  onClick={() => onRemoveChip(chip.key)}
                >
                  ×
                </button>
              </span>
            ))}
            <button type="button" className="filter-applied-band__clear" onClick={handleClearAll}>
              × Clear Filter
            </button>
          </div>
        )}
      </div>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Filter By"
        size="sm"
        footerClassName="drawer-footer--filters"
        footer={(
          <>
            <button type="button" className="btn btn-primary" onClick={handleApply}>
              Apply
            </button>
            <button type="button" className="btn btn-ghost" onClick={handleClearInDrawer} style={{ color: 'var(--red)' }}>
              Clear Filters
            </button>
          </>
        )}
      >
        <div className="filter-sidebar-fields">
          {fieldSet.has('customer') && (
            <FormGroup label="Customer">
              <AutocompleteDropdown
                value={draft.customerId}
                onChange={(id) => setDraftField('customerId', id)}
                onSelectOption={(opt) => {
                  setDraft((prev) => ({
                    ...prev,
                    customerId: opt?.id ?? '',
                    customerLabel: opt?.label ?? '',
                  }))
                }}
                onClear={() => {
                  setDraft((prev) => ({ ...prev, customerId: '', customerLabel: '' }))
                }}
                selectedLabel={draft.customerLabel}
                fetchUrl={AUTOCOMPLETE_CUSTOMER_URL}
                isSearchFieldRequired
                placeholder="Select customer"
                searchPlaceholder="Search customers…"
                clearable
                style={{ width: '100%' }}
              />
            </FormGroup>
          )}

          {fieldSet.has('vendor') && (
            <FormGroup label="Vendor">
              <AutocompleteDropdown
                value={draft.vendorId}
                onChange={(id) => setDraftField('vendorId', id)}
                onSelectOption={(opt) => {
                  setDraft((prev) => ({
                    ...prev,
                    vendorId: opt?.id ?? '',
                    vendorLabel: opt?.label ?? '',
                  }))
                }}
                onClear={() => {
                  setDraft((prev) => ({ ...prev, vendorId: '', vendorLabel: '' }))
                }}
                selectedLabel={draft.vendorLabel}
                fetchUrl={AUTOCOMPLETE_VENDOR_URL}
                isSearchFieldRequired
                placeholder="Select vendor"
                searchPlaceholder="Search vendors…"
                clearable
                style={{ width: '100%' }}
              />
            </FormGroup>
          )}

          {fieldSet.has('status') && (
            <FormGroup label="Status">
              <AutocompleteDropdown
                value={draft.status}
                onChange={(id) => setDraftField('status', id)}
                options={statusOpts}
                prependOptions={[{ id: '', label: 'All Status' }]}
                isSearchFieldRequired={false}
                placeholder="All Status"
                clearable
                onClear={() => setDraftField('status', '')}
                style={{ width: '100%' }}
              />
            </FormGroup>
          )}

          {fieldSet.has('paymentMode') && (
            <FormGroup label="Payment Method">
              <AutocompleteDropdown
                value={draft.paymentMode}
                onChange={(id) => setDraftField('paymentMode', id)}
                options={PAYMENT_METHOD_WITH_CREDIT_OPTIONS}
                prependOptions={[{ id: '', label: 'All Methods' }]}
                isSearchFieldRequired={false}
                placeholder="All Methods"
                clearable
                onClear={() => setDraftField('paymentMode', '')}
                style={{ width: '100%' }}
              />
            </FormGroup>
          )}

          {fieldSet.has('category') && (
            <FormGroup label="Category">
              <AutocompleteDropdown
                value={draft.categoryId}
                onChange={(id) => setDraftField('categoryId', id)}
                onSelectOption={(opt) => {
                  setDraft((prev) => ({
                    ...prev,
                    categoryId: opt?.id ?? '',
                    categoryLabel: opt?.label ?? '',
                  }))
                }}
                onClear={() => {
                  setDraft((prev) => ({ ...prev, categoryId: '', categoryLabel: '' }))
                }}
                selectedLabel={draft.categoryLabel}
                fetchUrl={AUTOCOMPLETE_CATEGORY_URL}
                isSearchFieldRequired
                placeholder="Select category"
                searchPlaceholder="Search categories…"
                clearable
                style={{ width: '100%' }}
              />
            </FormGroup>
          )}

          {fieldSet.has('discount') && (
            <FormGroup label="Discount">
              <AutocompleteDropdown
                value={draft.discount}
                onChange={(id) => setDraftField('discount', id)}
                options={DISCOUNT_OPTIONS}
                isSearchFieldRequired={false}
                placeholder="All"
                clearable
                onClear={() => setDraftField('discount', '')}
                style={{ width: '100%' }}
              />
            </FormGroup>
          )}

          {fieldSet.has('date') && (
            <FormGroup label="Date Range">
              <div className="filter-sidebar-dates">
                <DatePicker
                  style={{ width: '100%' }}
                  value={draft.dateFrom}
                  onChange={(v) => setDraftField('dateFrom', v)}
                  placeholder="From"
                />
                <DatePicker
                  style={{ width: '100%' }}
                  value={draft.dateTo}
                  onChange={(v) => setDraftField('dateTo', v)}
                  placeholder="To"
                />
              </div>
            </FormGroup>
          )}

        </div>
      </Drawer>
    </>
  )
}

/** @deprecated use ListFilters */
export { ListFilters as SalesListFilters }
/** @deprecated use ListFilters */
export { ListFilters as InvoiceListFilters }
