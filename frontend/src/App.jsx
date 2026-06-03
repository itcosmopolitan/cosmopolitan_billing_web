import { useEffect, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAppStore } from '@/store'
import { authAPI, branchesAPI, permissionsAPI, taxRatesAPI } from '@/api'
import { fetchAllList } from '@/utils/pagination'
import { RequireAuth, RequirePasswordSet, RequirePerm } from '@/auth/guards'
import Sidebar from '@/components/layout/Sidebar'
import Topbar from '@/components/layout/Topbar'
import LoginPage from '@/pages/auth/LoginPage'
import ChangePasswordPage from '@/pages/auth/ChangePasswordPage'

import Dashboard     from '@/pages/dashboard/Dashboard'
import POSPage       from '@/pages/pos/POSPage'
import ItemsPage     from '@/pages/inventory/ItemsPage'
import ItemMasterPage from '@/pages/inventory/ItemMasterPage'
import NewItemPage from '@/pages/inventory/NewItemPage'
import EditItemPage from '@/pages/inventory/EditItemPage'
import TransfersPage from '@/pages/inventory/TransfersPage'
import SalesPage     from '@/pages/sales/SalesPage'
import PurchasesPage from '@/pages/purchases/PurchasesPage'
import CustomersPage from '@/pages/customers/CustomersPage'
import VendorsPage   from '@/pages/vendors/VendorsPage'
import CashPage      from '@/pages/cash/CashPage'
import ReportsPage   from '@/pages/reports/ReportsPage'
import SettingsPage  from '@/pages/settings/SettingsPage'
import AuditPage     from '@/pages/settings/AuditPage'

function AppShell() {
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  // Must stay in sync with the SIDEBAR_W / SIDEBAR_W_COLLAPSED constants in
  // components/layout/Sidebar.jsx — single source of truth there, mirrored
  // here for the main-content margin.
  const sidebarW = sidebarCollapsed ? 68 : 244
  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar />
      <div style={{ marginLeft: sidebarW, flex: 1, display: 'flex', flexDirection: 'column', minHeight: '100vh', transition: 'margin-left 0.2s ease' }}>
        <Topbar />
        <main style={{ flex: 1 }}>
          <Routes>
            <Route path="/"           element={<Navigate to="/dashboard" replace />} />
            {/* Phase 2 + 3 — every module route is gated on its `*.view`
                permission. Sidebar nav already filters by useCan(), so a
                user can't normally land here without the perm; this is
                belt-and-braces. */}
            <Route path="/dashboard"  element={<RequirePerm perm="dashboard.view"><Dashboard /></RequirePerm>} />
            <Route path="/pos"        element={<RequirePerm perm="pos.use"><POSPage /></RequirePerm>} />
            <Route path="/item-master" element={<RequirePerm perm="items.view"><ItemMasterPage /></RequirePerm>} />
            <Route path="/item-master/new" element={<RequirePerm perm="items.create"><NewItemPage /></RequirePerm>} />
            <Route path="/item-master/:itemId/edit" element={<RequirePerm perm="items.edit"><EditItemPage /></RequirePerm>} />
            <Route path="/items"      element={<RequirePerm perm="items.view"><ItemsPage /></RequirePerm>} />
            <Route path="/transfers"  element={<RequirePerm perm="transfers.view"><TransfersPage /></RequirePerm>} />
            <Route path="/sales"      element={<RequirePerm perm="invoices.view"><SalesPage /></RequirePerm>} />
            <Route path="/purchases"  element={<RequirePerm perm="purchases.view"><PurchasesPage /></RequirePerm>} />
            <Route path="/customers"  element={<RequirePerm perm="customers.view"><CustomersPage /></RequirePerm>} />
            <Route path="/vendors"    element={<RequirePerm perm="vendors.view"><VendorsPage /></RequirePerm>} />
            <Route path="/cash"       element={<RequirePerm perm="cash.view"><CashPage /></RequirePerm>} />
            <Route path="/reports"    element={<RequirePerm perm="reports.view"><ReportsPage /></RequirePerm>} />
            <Route path="/settings"   element={<RequirePerm perm="settings.view"><SettingsPage /></RequirePerm>} />
            <Route path="/audit"      element={<RequirePerm perm="audit.view"><AuditPage /></RequirePerm>} />
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
  const setTaxPricingMode = useAppStore((s) => s.setTaxPricingMode)
  const [booting, setBooting] = useState(true)

  useEffect(() => {
    const nextTheme = theme === 'dark' ? 'dark' : 'light'
    document.documentElement.setAttribute('data-theme', nextTheme)
    document.documentElement.style.colorScheme = nextTheme
  }, [theme])

  // Boot-time hydration. If a token is present we resolve the real user via
  // /auth/me (Phase 1.5 — fixes ISS-002 / ISS-003). The catalog and branches
  // list are open-access, so we always fetch them. Skipping /auth/me when no
  // token is present avoids the 401-redirect loop the global axios
  // interceptor would otherwise trigger.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const token = localStorage.getItem('retailos_token')
        const tasks = [
          permissionsAPI.catalog().catch(() => ({})),
          fetchAllList(branchesAPI.list).catch(() => []),
          taxRatesAPI.getSettings().catch(() => ({ tax_pricing_mode: 'inclusive' })),
        ]
        if (token) tasks.push(authAPI.me().catch(() => null))
        const [catalog, branches, taxSettings, me] = await Promise.all(tasks)
        if (cancelled) return
        setPermCatalog(catalog || {})
        setBranches(branches || [])
        setTaxPricingMode(taxSettings?.tax_pricing_mode || 'inclusive')
        if (token && me) {
          setSession({ user: me, permissions: me.permissions || [] })
        }
      } finally {
        if (!cancelled) setBooting(false)
      }
    })()
    return () => { cancelled = true }
  }, [setSession, setPermCatalog, setBranches, setTaxPricingMode])

  if (booting) return <BootSplash />

  return (
    <Routes>
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
  )
}
