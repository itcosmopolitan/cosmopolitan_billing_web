import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import * as Icon from '@/components/ui/Icons'

export default function HelpPage() {
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState('shortcuts')

  const KEYBOARD_SHORTCUTS = [
    { keys: 'F2', description: 'Search for products (POS)', context: 'POS' },
    { keys: 'F4', description: 'Hold current bill', context: 'POS' },
    { keys: 'F8', description: 'Complete sale / Checkout', context: 'POS' },
    { keys: 'Esc', description: 'Cancel dialog or clear search', context: 'Global' },
    { keys: 'Enter', description: 'Confirm action', context: 'Forms' },
    { keys: 'Tab', description: 'Move to next field', context: 'Forms' },
    { keys: 'Shift + Tab', description: 'Move to previous field', context: 'Forms' },
    { keys: 'Ctrl/Cmd + S', description: 'Save form', context: 'Forms' },
  ]

  const QUICK_TIPS = [
    {
      title: 'POS - Fast Billing',
      icon: '🧾',
      tips: [
        'Use barcode scanner for fast product entry',
        'Press F2 to search products by name or code',
        'Press F4 to hold a bill and start a new one',
        'Use arrow keys to adjust quantities',
        'Apply discounts before payment',
      ],
    },
    {
      title: 'Inventory Management',
      icon: '📦',
      tips: [
        'Multi-branch stock view shows inventory across all locations',
        'Low stock alerts help you reorder before running out',
        'Stock adjustments maintain audit trail for compliance',
        'Use filters to find items quickly',
        'Export inventory reports for analysis',
      ],
    },
    {
      title: 'Sales & Invoicing',
      icon: '📄',
      tips: [
        'Create quotations before converting to orders',
        'GST is calculated automatically based on item rates',
        'Record partial payments and track outstanding balances',
        'Issue credit notes for returns and adjustments',
        'Filter invoices by date, customer, or status',
      ],
    },
    {
      title: 'Financial Management',
      icon: '💰',
      tips: [
        'Cash register tracks daily transactions per branch',
        'Daily reconciliation detects discrepancies',
        'Reports provide insights into sales trends',
        'Tax summary helps with compliance filing',
        'Margin analysis shows profitability by product',
      ],
    },
    {
      title: 'Stock Transfers',
      icon: '🔄',
      tips: [
        '4-step workflow: Request → Approve → Dispatch → Receive',
        'Stock is reserved during request and transferred on dispatch',
        'Track in-transit inventory between branches',
        'Complete audit trail for all transfers',
        'Approve transfers based on your role',
      ],
    },
    {
      title: 'User Permissions',
      icon: '🔐',
      tips: [
        'Different roles have different access levels',
        'Admins manage users and roles',
        'Managers oversee branch operations',
        'Accountants handle financial records',
        'Cashiers focus on POS and sales',
      ],
    },
  ]

  const FEATURE_HIGHLIGHTS = [
    {
      category: 'Point of Sale',
      features: [
        'Touch-friendly interface optimized for tablets',
        'Barcode scanning with product search',
        'Live cart with real-time GST calculations',
        'Multiple payment methods: Cash, Card, UPI, Credit',
        'Hold & resume multiple bills simultaneously',
        'Thermal receipt printing + WhatsApp sharing',
      ],
    },
    {
      category: 'Inventory',
      features: [
        'Real-time multi-branch stock view',
        'Low stock alerts and reorder levels',
        'Stock adjustments with full audit trail',
        'Item master with HSN, GST, and barcode',
        'Stock valuation reports',
        'Barcode label printing',
      ],
    },
    {
      category: 'Sales & Invoicing',
      features: [
        'Sales invoices with line-item discounts',
        'Quotations and sales orders',
        'Credit notes and returns processing',
        'GST compliance with tax calculations',
        'Outstanding balance tracking',
        'Partial payment support',
      ],
    },
    {
      category: 'Purchasing',
      features: [
        'Purchase bills with vendor management',
        'Purchase orders and GRN (Goods Receipt Note)',
        'Vendor return processing',
        'Payment terms tracking',
        'Outstanding payables management',
      ],
    },
    {
      category: 'Reports & Analytics',
      features: [
        'Sales register with payment breakdown',
        'Purchase register with vendor analysis',
        'Stock movement tracking',
        'Inventory valuation',
        'Margin analysis',
        'Tax summary for compliance',
      ],
    },
    {
      category: 'Administration',
      features: [
        'Role-based access control (6 role types)',
        'Granular permissions by action',
        'Branch-level access isolation',
        'Complete audit trail of all changes',
        'User activity tracking',
        'System settings and configuration',
      ],
    },
  ]

  const FAQ = [
    {
      q: 'How do I reset my password?',
      a: 'Click "Forgot Password" on the login page and follow the instructions sent to your email.',
    },
    {
      q: 'Can I use this on mobile?',
      a: 'Yes! The application is responsive and works on tablets and mobile browsers. POS is optimized for touch devices.',
    },
    {
      q: 'How often is data backed up?',
      a: 'Automatic backups are performed daily. Contact your administrator for backup schedules and recovery procedures.',
    },
    {
      q: 'What payment methods are supported?',
      a: 'Cash, Card, UPI, and Credit (on-account). Settings allow you to enable/disable payment methods per branch.',
    },
    {
      q: 'How do I create a new user?',
      a: 'Go to Settings > Users & Roles. Only administrators can create new users. Assign a role based on their responsibilities.',
    },
    {
      q: 'Can I transfer stock between branches?',
      a: 'Yes! Use the Transfers module. Create a transfer request, get approval, dispatch, and receive at the destination.',
    },
    {
      q: 'How do I view GST reports?',
      a: 'Go to Reports > Tax Summary. Filter by date range and branch. Export for compliance filing.',
    },
    {
      q: 'What does "Low Stock Alert" mean?',
      a: 'Items below the reorder level trigger alerts. This helps you maintain adequate inventory and avoid stockouts.',
    },
    {
      q: 'How do I record a return from a customer?',
      a: 'Go to Sales > Returns > New Return. Reference the original invoice and specify returned items and quantities.',
    },
    {
      q: 'Is there an offline mode?',
      a: 'Currently, the application requires an internet connection. An offline sync feature is on the roadmap.',
    },
  ]

  return (
    <div className="page-container">
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon.HelpCircle size={32} style={{ color: 'var(--accent)' }} />
          Help & Documentation
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>
          Learn how to use Cosmopolitan Pro with shortcuts, tips, features, and frequently asked questions.
        </p>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24, borderBottom: '1px solid var(--border-default)', overflowX: 'auto' }}>
        {[
          { id: 'shortcuts', label: 'Keyboard Shortcuts', icon: '⌨️' },
          { id: 'tips', label: 'Quick Tips', icon: '💡' },
          { id: 'features', label: 'Features', icon: '✨' },
          { id: 'faq', label: 'FAQ', icon: '❓' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '12px 16px',
              display: 'flex', alignItems: 'center', gap: 8,
              background: 'transparent',
              border: 'none',
              borderBottom: activeTab === tab.id ? '2px solid var(--accent)' : '2px solid transparent',
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: activeTab === tab.id ? 600 : 500,
              color: activeTab === tab.id ? 'var(--accent)' : 'var(--text-secondary)',
              whiteSpace: 'nowrap',
              transition: 'all 150ms ease',
            }}
            onMouseEnter={(e) => {
              if (activeTab !== tab.id) {
                e.currentTarget.style.color = 'var(--text-primary)'
              }
            }}
            onMouseLeave={(e) => {
              if (activeTab !== tab.id) {
                e.currentTarget.style.color = 'var(--text-secondary)'
              }
            }}
          >
            <span>{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Keyboard Shortcuts */}
      {activeTab === 'shortcuts' && (
        <div style={{ marginBottom: 32 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))', gap: 16 }}>
            {KEYBOARD_SHORTCUTS.map((shortcut, i) => (
              <div
                key={i}
                style={{
                  padding: '16px',
                  background: 'var(--bg-raised)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 10,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 16,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minWidth: 70,
                    padding: '8px 12px',
                    background: 'var(--accent)',
                    color: '#fff',
                    borderRadius: 8,
                    fontFamily: 'DM Mono',
                    fontWeight: 600,
                    fontSize: 12,
                  }}
                >
                  {shortcut.keys}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text-primary)' }}>
                    {shortcut.description}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {shortcut.context}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Quick Tips */}
      {activeTab === 'tips' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))', gap: 20 }}>
          {QUICK_TIPS.map((section, i) => (
            <div
              key={i}
              style={{
                padding: '20px',
                background: 'var(--bg-raised)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 12,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                <span style={{ fontSize: 28 }}>{section.icon}</span>
                <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>
                  {section.title}
                </h3>
              </div>
              <ul style={{ margin: 0, paddingLeft: 20, listStyleType: 'disc' }}>
                {section.tips.map((tip, j) => (
                  <li key={j} style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.5 }}>
                    {tip}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* Features */}
      {activeTab === 'features' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))', gap: 20 }}>
          {FEATURE_HIGHLIGHTS.map((section, i) => (
            <div
              key={i}
              style={{
                padding: '20px',
                background: 'var(--bg-raised)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 12,
              }}
            >
              <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 14, color: 'var(--accent)', margin: '0 0 14px 0' }}>
                {section.category}
              </h3>
              <ul style={{ margin: 0, paddingLeft: 20, listStyleType: 'disc' }}>
                {section.features.map((feature, j) => (
                  <li key={j} style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8, lineHeight: 1.5 }}>
                    {feature}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* FAQ */}
      {activeTab === 'faq' && (
        <div style={{ maxWidth: 800, margin: '0 auto' }}>
          {FAQ.map((item, i) => (
            <details
              key={i}
              style={{
                padding: '16px',
                marginBottom: 12,
                background: 'var(--bg-raised)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 10,
                cursor: 'pointer',
              }}
            >
              <summary
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: 'var(--text-primary)',
                  userSelect: 'none',
                }}
              >
                {item.q}
              </summary>
              <p
                style={{
                  margin: '12px 0 0 0',
                  fontSize: 13.5,
                  color: 'var(--text-secondary)',
                  lineHeight: 1.6,
                  borderTop: '1px solid var(--border-subtle)',
                  paddingTop: 12,
                }}
              >
                {item.a}
              </p>
            </details>
          ))}
        </div>
      )}

      {/* Footer */}
      <div style={{
        marginTop: 40,
        padding: '20px',
        background: 'var(--bg-raised)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 12,
        textAlign: 'center',
      }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: 'var(--text-primary)' }}>
          📖 Need a Detailed User Guide?
        </h3>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
          Read step-by-step instructions for every task in the comprehensive user guide, written in simple language for everyone.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => navigate('/docs/USER_GUIDE.md')}
          >
            📖 Read User Guide
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => navigate('/docs')}
          >
            View All Documentation
          </button>
        </div>
      </div>
    </div>
  )
}
