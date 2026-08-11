/**
 * Shared props for list `<tr>` rows that open a detail view on click.
 *
 * Ignores clicks that originate from interactive controls (links, buttons,
 * checkboxes, the row-actions menu). Mark any other interactive cell with
 * `data-no-row-click` if needed.
 *
 * Usage:
 *   <tr key={row.id} {...tableRowClickProps(() => setShowDetail(row))}>
 */
export function tableRowClickProps(onActivate, { title = 'View details', style } = {}) {
  if (typeof onActivate !== 'function') return {}

  const shouldIgnore = (target) => {
    if (!(target instanceof Element)) return true
    return Boolean(
      target.closest(
        'a, button, input, select, textarea, label, [role="menuitem"], [data-no-row-click]',
      ),
    )
  }

  return {
    role: 'link',
    tabIndex: 0,
    title,
    style: { cursor: 'pointer', ...(style || {}) },
    onClick: (e) => {
      if (shouldIgnore(e.target)) return
      onActivate()
    },
    onKeyDown: (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      if (shouldIgnore(e.target)) return
      e.preventDefault()
      onActivate()
    },
  }
}
