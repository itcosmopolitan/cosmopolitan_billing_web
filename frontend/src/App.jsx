import { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAppStore } from '@/store'
import Sidebar from '@/components/layout/Sidebar'
import Topbar from '@/components/layout/Topbar'
import LoginPage from '@/pages/auth/LoginPage'

import Dashboard     from '@/pages/dashboard/Dashboard'
import POSPage       from '@/pages/pos/POSPage'
import ItemsPage     from '@/pages/inventory/ItemsPage'
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
  const { sidebarCollapsed } = useAppStore()
  const sidebarW = sidebarCollapsed ? 56 : 220
  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar />
      <div style={{ marginLeft: sidebarW, flex: 1, display: 'flex', flexDirection: 'column', minHeight: '100vh', transition: 'margin-left 0.2s ease' }}>
        <Topbar />
        <main style={{ flex: 1 }}>
          <Routes>
            <Route path="/"           element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard"  element={<Dashboard />} />
            <Route path="/pos"        element={<POSPage />} />
            <Route path="/items"      element={<ItemsPage />} />
            <Route path="/transfers"  element={<TransfersPage />} />
            <Route path="/sales"      element={<SalesPage />} />
            <Route path="/purchases"  element={<PurchasesPage />} />
            <Route path="/customers"  element={<CustomersPage />} />
            <Route path="/vendors"    element={<VendorsPage />} />
            <Route path="/cash"       element={<CashPage />} />
            <Route path="/reports"    element={<ReportsPage />} />
            <Route path="/settings"   element={<SettingsPage />} />
            <Route path="/audit"      element={<AuditPage />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}

export default function App() {
  const { theme } = useAppStore()

  useEffect(() => {
    const nextTheme = theme === 'dark' ? 'dark' : 'light'
    document.documentElement.setAttribute('data-theme', nextTheme)
    document.documentElement.style.colorScheme = nextTheme
  }, [theme])

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/*"     element={<AppShell />} />
    </Routes>
  )
}
