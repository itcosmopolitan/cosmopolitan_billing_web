import { lazy, Suspense, useEffect, useState } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useAppStore } from '@/store'
import { setupAPI } from '@/api'
import {
  applyBootstrapToStore,
  bootstrapAuthenticatedData,
  bootstrapPublicData,
} from '@/auth/bootstrap'
import { RequireAuth, RequirePasswordSet, RequirePerm } from '@/auth/guards'
import Sidebar from '@/components/layout/Sidebar'
import Topbar from '@/components/layout/Topbar'
import LoginPage from '@/pages/auth/LoginPage'
import SetupPage from '@/pages/auth/SetupPage'
import ChangePasswordPage from '@/pages/auth/ChangePasswordPage'

const Dashboard = lazy(() => import('@/features/dashboard/DashboardPage'))
const POSPage = lazy(() => import('@/pages/pos/POSPage'))
const ItemsPage = lazy(() => import('@/pages/inventory/ItemsPage'))
const ItemMasterPage = lazy(() => import('@/pages/inventory/ItemMasterPage'))
const NewItemPage = lazy(() => import('@/pages/inventory/NewItemPage'))
const EditItemPage = lazy(() => import('@/pages/inventory/EditItemPage'))
const TransfersPage = lazy(() => import('@/pages/inventory/TransfersPage'))
const NewTransferPage = lazy(() => import('@/pages/inventory/NewTransferPage'))
const EditTransferPage = lazy(() => import('@/pages/inventory/EditTransferPage'))
const AdjustmentsPage = lazy(() => import('@/pages/inventory/AdjustmentsPage'))
const SalesPage = lazy(() => import('@/pages/sales/SalesPage'))
const QuoteFormPage = lazy(() => import('@/pages/sales/QuoteFormPage'))
const OrderFormPage = lazy(() => import('@/pages/sales/OrderFormPage'))
const InvoiceFormPage = lazy(() => import('@/pages/sales/InvoiceFormPage'))
const InvoiceEditPage = lazy(() => import('@/pages/sales/InvoiceEditPage'))
const PaymentFormPage = lazy(() => import('@/pages/sales/PaymentFormPage'))
const ReturnFormPage = lazy(() => import('@/pages/sales/ReturnFormPage'))
const PurchasesPage = lazy(() => import('@/pages/purchases/PurchasesPage'))
const PurchaseOrderFormPage = lazy(() => import('@/pages/purchases/PurchaseOrderFormPage'))
const BillFormPage = lazy(() => import('@/pages/purchases/BillFormPage'))
const BillEditPage = lazy(() => import('@/pages/purchases/BillEditPage'))
const VendorPaymentFormPage = lazy(() => import('@/pages/purchases/VendorPaymentFormPage'))
const VendorReturnFormPage = lazy(() => import('@/pages/purchases/VendorReturnFormPage'))
const CustomersPage = lazy(() => import('@/pages/customers/CustomersPage'))
const VendorsPage = lazy(() => import('@/pages/vendors/VendorsPage'))
const CashPage = lazy(() => import('@/pages/cash/CashPage'))
const CashMonitorPage = lazy(() => import('@/pages/cash/CashMonitorPage'))
const ReportsPage = lazy(() => import('@/pages/reports/ReportsPage'))
const SettingsPage = lazy(() => import('@/pages/settings/SettingsPage'))
const AuditTrailPage = lazy(() => import('@/pages/AuditTrail'))
const CustomerDisplayPage = lazy(() => import('@/pages/display/CustomerDisplayPage'))
const SalesTaxInvoicePreview = lazy(() => import('@/pages/invoices/SalesTaxInvoicePreview'))

function AppShell() {
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  // Must stay in sync with the SIDEBAR_W / SIDEBAR_W_COLLAPSED constants in
  // components/layout/Sidebar.jsx — single source of truth there, mirrored
  // here for the main-content margin.
  const sidebarW = sidebarCollapsed ? 68 : 220
  return (
    <div style={{ display: 'flex', minHeight: '100vh', overflowX: 'hidden' }}>
      <Sidebar />
      <div style={{ marginLeft: sidebarW, flex: 1, display: 'flex', flexDirection: 'column', minHeight: '100vh', transition: 'margin-left 0.2s ease', overflowX: 'hidden' }}>
        <Topbar />
        <main style={{ flex: 1, overflowX: 'hidden' }}>
          <Routes>
            <Route path="/"           element={<Navigate to="/dashboard" replace />} />
            {/* Phase 2 + 3 — every module route is gated on its `*.view`
                permission. Sidebar nav already filters by useCan(), so a
                user can't normally land here without the perm; this is
                belt-and-braces. */}
            <Route path="/dashboard"  element={<RequirePerm perm="dashboard.view"><Dashboard /></RequirePerm>} />
            <Route path="/pos"        element={<RequirePerm perm="pos.use"><POSPage /></RequirePerm>} />
            <Route path="/item-master" element={<RequirePerm perm="item_master.view"><ItemMasterPage /></RequirePerm>} />
            <Route path="/item-master/new" element={<RequirePerm perm="item_master.create"><NewItemPage /></RequirePerm>} />
            <Route path="/item-master/:itemId/edit" element={<RequirePerm perm="item_master.edit"><EditItemPage /></RequirePerm>} />
            <Route path="/items"      element={<RequirePerm perm="items.view"><ItemsPage /></RequirePerm>} />
            <Route path="/transfers"  element={<RequirePerm perm="transfers.view"><TransfersPage /></RequirePerm>} />
            <Route path="/transfers/new" element={<RequirePerm perm="transfers.create"><NewTransferPage /></RequirePerm>} />
            <Route path="/transfers/:transferId/edit" element={<RequirePerm perm="transfers.create"><EditTransferPage /></RequirePerm>} />
            <Route path="/adjustments" element={<RequirePerm perm="adjustments.view"><AdjustmentsPage /></RequirePerm>} />
            <Route path="/sales"      element={<RequirePerm perm="invoices.view"><SalesPage /></RequirePerm>} />
            <Route path="/sales/quotations/new" element={<RequirePerm perm="invoices.create"><QuoteFormPage mode="create" /></RequirePerm>} />
            <Route path="/sales/quotations/:quoteId/edit" element={<RequirePerm perm="invoices.edit"><QuoteFormPage mode="edit" /></RequirePerm>} />
            <Route path="/sales/orders/new" element={<RequirePerm perm="invoices.create"><OrderFormPage mode="create" /></RequirePerm>} />
            <Route path="/sales/orders/:orderId/edit" element={<RequirePerm perm="invoices.edit"><OrderFormPage mode="edit" /></RequirePerm>} />
            <Route path="/sales/invoices/new" element={<RequirePerm perm="invoices.create"><InvoiceFormPage /></RequirePerm>} />
            <Route path="/sales/invoices/:invoiceId/edit" element={<RequirePerm perm="invoices.edit"><InvoiceEditPage /></RequirePerm>} />
            <Route path="/sales/payments/new" element={<RequirePerm perm="invoices.edit"><PaymentFormPage /></RequirePerm>} />
            <Route path="/sales/returns/new" element={<RequirePerm perm="invoices.create"><ReturnFormPage /></RequirePerm>} />
            <Route path="/purchases"  element={<RequirePerm perm="purchases.view"><PurchasesPage /></RequirePerm>} />
            <Route path="/purchases/orders/new" element={<RequirePerm perm="purchases.create"><PurchaseOrderFormPage mode="create" /></RequirePerm>} />
            <Route path="/purchases/orders/:orderId/edit" element={<RequirePerm perm="purchases.edit"><PurchaseOrderFormPage mode="edit" /></RequirePerm>} />
            <Route path="/purchases/bills/new" element={<RequirePerm perm="purchases.create"><BillFormPage mode="bill" /></RequirePerm>} />
            <Route path="/purchases/bills/:billId/edit" element={<RequirePerm perm="purchases.edit"><BillEditPage /></RequirePerm>} />
            <Route path="/purchases/grns/new" element={<RequirePerm perm="purchases.create"><BillFormPage mode="grn" /></RequirePerm>} />
            <Route path="/purchases/payments/new" element={<RequirePerm perm="purchases.edit"><VendorPaymentFormPage /></RequirePerm>} />
            <Route path="/purchases/returns/new" element={<RequirePerm perm="purchases.create"><VendorReturnFormPage /></RequirePerm>} />
            <Route path="/customers"  element={<RequirePerm perm="customers.view"><CustomersPage /></RequirePerm>} />
            <Route path="/vendors"    element={<RequirePerm perm="vendors.view"><VendorsPage /></RequirePerm>} />
            <Route path="/cash"         element={<RequirePerm perm="cash.view"><CashPage /></RequirePerm>} />
            <Route path="/cash/monitor" element={<RequirePerm perm="cash.monitor"><CashMonitorPage /></RequirePerm>} />
            <Route path="/reports"    element={<RequirePerm perm="reports.view"><ReportsPage /></RequirePerm>} />
            <Route path="/settings"   element={<RequirePerm perm="settings.view"><SettingsPage /></RequirePerm>} />
            <Route path="/audit"      element={<RequirePerm perm="audit.view"><AuditTrailPage /></RequirePerm>} />
            <Route path="/invoice-preview" element={<SalesTaxInvoicePreview />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}

/** Tiny splash shown while the boot fetch runs, to avoid a flicker of
 *  "logged out" UI before /auth/me resolves. */
function BootSplash() {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg-base)', color: 'var(--text-muted)', fontSize: 13,
    }}>
      Loading…
    </div>
  )
}

export default function App() {
  const theme = useAppStore((s) => s.theme)
  const setSession = useAppStore((s) => s.setSession)
  const setPermCatalog = useAppStore((s) => s.setPermCatalog)
  const setBranches = useAppStore((s) => s.setBranches)
  const location = useLocation()
  const [booting, setBooting] = useState(true)
  const [setupStatusResolved, setSetupStatusResolved] = useState(false)
  const [setupRequired, setSetupRequired] = useState(false)

  useEffect(() => {
    const nextTheme = theme === 'dark' ? 'dark' : 'light'
    document.documentElement.setAttribute('data-theme', nextTheme)
    document.documentElement.style.colorScheme = nextTheme
  }, [theme])

  // Boot-time hydration. Public catalog always; branches + /auth/me only with token.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const token = localStorage.getItem('retailos_token')
        const setupStatus = await setupAPI.status().catch(() => ({ required: false }))
        if (cancelled) return
        const required = Boolean(setupStatus?.required)
        setSetupRequired(required)
        if (required && !token) {
          setBooting(false)
          return
        }

        const data = token
          ? await bootstrapAuthenticatedData({ includeBranches: false })
          : { ...(await bootstrapPublicData()), branches: [], user: null, permissions: [] }
        if (cancelled) return
        applyBootstrapToStore(data, { setSession, setPermCatalog, setBranches })

        if (token) {
          const branchData = await bootstrapAuthenticatedData({ includeBranches: true }).catch(() => ({
            catalog: {},
            branches: [],
            user: null,
            permissions: [],
          }))
          if (!cancelled) {
            applyBootstrapToStore(branchData, { setSession, setPermCatalog, setBranches })
          }
        }
      } finally {
        if (!cancelled) {
          setBooting(false)
          setSetupStatusResolved(true)
        }
      }
    })()
    return () => { cancelled = true }
  }, [setSession, setPermCatalog, setBranches])

  if (!setupStatusResolved || booting) return <BootSplash />
  if (setupRequired && location.pathname !== '/setup') return <Navigate to="/setup" replace />

  return (
    <Suspense fallback={<BootSplash />}>
      <Routes>
        {/* Public live display routes — no login; open on second device/monitor. */}
        <Route path="/customer-view" element={<CustomerDisplayPage />} />
        <Route path="/customer-view/:roomId" element={<CustomerDisplayPage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<LoginPage />} />
        {/* /change-password sits OUTSIDE the RequirePasswordSet wrap on purpose
            — that's the one route users with must_change_password=true need to
            reach. RequireAuth still applies, so visiting it without a JWT
            bounces to /login. */}
        <Route
          path="/change-password"
          element={
            <RequireAuth>
              <ChangePasswordPage />
            </RequireAuth>
          }
        />
        <Route
          path="/*"
          element={
            <RequireAuth>
              <RequirePasswordSet>
                <AppShell />
              </RequirePasswordSet>
            </RequireAuth>
          }
        />
      </Routes>
    </Suspense>
  )
}
