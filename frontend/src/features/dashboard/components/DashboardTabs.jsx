import PermissionGate from './PermissionGate'

export default function DashboardTabs({ tabs, activeTab, onChange }) {
  return (
    <div className="tabs-bar" style={{ marginBottom: 16 }}>
      {tabs.map((tab) => (
        <PermissionGate key={tab.id} permission={tab.permission}>
          <button
            type="button"
            className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
          </button>
        </PermissionGate>
      ))}
    </div>
  )
}
