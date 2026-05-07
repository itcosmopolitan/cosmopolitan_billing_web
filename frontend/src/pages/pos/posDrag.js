// Constants + helpers shared by POSPage and the PanelDragHandle component.
// Centralised here so both ends of the drag contract import the same MIME
// type and storage keys (renaming one without the other was a pain point).

export const POS_STORAGE_SPLIT = 'pos.leftPaneRatio'
export const POS_STORAGE_LEADING = 'pos.leadingPanel'
export const POS_DRAG_MIME = 'application/x-pos-panel'

export function readStoredSplit() {
  try {
    const v = Number(localStorage.getItem(POS_STORAGE_SPLIT))
    if (Number.isFinite(v) && v >= 30 && v <= 70) return v
  } catch {
    // ignore
  }
  return 50
}

export function readStoredLeading() {
  try {
    const v = localStorage.getItem(POS_STORAGE_LEADING)
    if (v === 'cart' || v === 'products') return v
  } catch {
    // ignore
  }
  return 'products'
}

/** dropSide 'left'|'right', dragged 'products'|'cart' → which panel is on the left */
export function leadingPanelFromDrop(dropSide, dragged) {
  if (dropSide === 'left') return dragged
  return dragged === 'products' ? 'cart' : 'products'
}
