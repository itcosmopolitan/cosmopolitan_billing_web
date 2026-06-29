import { useAppStore } from '@/store'
import { SectionHeader, Card } from '@/components/ui'

const SIDEBAR_W = 244
const SIDEBAR_W_COLLAPSED = 68

/**
 * Full-page document form layout — mirrors ItemFormPage / TransferFormPage.
 * Fixed footer with Back + Save; body scrolls inside Card.
 */
export default function DocumentFormShell({
  title,
  subtitle,
  icon,
  children,
  onBack,
  backLabel = '← Back',
  onSave,
  saveLabel = 'Save',
  saving = false,
  readOnly = false,
  summaryCards = [],
  hideHeader = false,
}) {
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  const footerLeft = sidebarCollapsed ? SIDEBAR_W_COLLAPSED : SIDEBAR_W

  return (
    <div className="page-container page-container--with-footer">
      {!hideHeader && <SectionHeader title={title} subtitle={subtitle} icon={icon} />}
      {Array.isArray(summaryCards) && summaryCards.length > 0 && (
        <div className="transfer-hero" style={{ marginBottom: 14 }}>
          <div className="transfer-hero__copy">
            <div className="transfer-hero__eyebrow">Quick summary</div>
            <h1 style={{ fontSize: 22, marginBottom: 0 }}>{title}</h1>
          </div>
          <div className="transfer-hero__stats">
            {summaryCards.slice(0, 3).map((card) => (
              <div className="transfer-stat" key={card.label}>
                <span>{card.label}</span>
                <strong>{card.value}</strong>
              </div>
            ))}
          </div>
        </div>
      )}
      <Card>{children}</Card>
      <div className="page-footer-bar" style={{ left: footerLeft }}>
        <button type="button" className="btn btn-secondary" onClick={onBack} disabled={saving}>
          {backLabel}
        </button>
        {!readOnly && onSave && (
          <button type="button" className="btn btn-primary" onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : saveLabel}
          </button>
        )}
      </div>
    </div>
  )
}
