import { useCallback, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { settingsAPI } from '@/api'
import { useAppStore } from '@/store'

const LEGACY_STORAGE_PREFIX = 'cosmo.columnPrefs.v1.'

function clearLegacyStored(key) {
  try {
    localStorage.removeItem(LEGACY_STORAGE_PREFIX + key)
  } catch {
    /* ignore */
  }
}

/** Build default order + hidden from server column defs. */
export function defaultPrefsFromDefs(defs = []) {
  const order = defs.map((d) => d.id)
  const hidden = defs.filter((d) => d.defaultHidden && !d.locked).map((d) => d.id)
  return { order, hidden }
}

/**
 * Merge stored prefs with server defs so new/removed columns stay valid.
 * Locked columns are never hidden.
 */
export function resolvePrefs(defs = [], stored) {
  const defIds = defs.map((d) => d.id)
  const defSet = new Set(defIds)
  const defaults = defaultPrefsFromDefs(defs)

  let order = (stored?.order || []).filter((id) => defSet.has(id))
  for (const id of defIds) {
    if (!order.includes(id)) order.push(id)
  }
  if (!order.length) order = defaults.order

  const locked = new Set(defs.filter((d) => d.locked).map((d) => d.id))
  const hiddenSource = stored?.hidden != null ? stored.hidden : defaults.hidden
  const hidden = hiddenSource.filter((id) => defSet.has(id) && !locked.has(id))

  return { order, hidden }
}

function normalizeColumns(columns) {
  if (!Array.isArray(columns)) return []
  return columns
    .filter((d) => d && d.id)
    .map((d) => ({
      id: String(d.id),
      label: d.label != null ? String(d.label) : String(d.id),
      locked: Boolean(d.locked),
      defaultHidden: Boolean(d.defaultHidden),
    }))
}

/**
 * List-table column layout from the server catalog (boot: GET /settings/column-prefs).
 * Prefs are derived from the store — no sync effects (keeps hook order stable).
 *
 * @param {string} tableKey e.g. "customers.list", "sales.invoices"
 */
export default function useColumnPrefs(tableKey) {
  const table = useAppStore((s) => s.columnTables?.[tableKey])
  const setColumnTables = useAppStore((s) => s.setColumnTables)
  const setColumnTable = useAppStore((s) => s.setColumnTable)

  const [customizeOpen, setCustomizeOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const defs = useMemo(() => normalizeColumns(table?.columns), [table])

  const prefs = useMemo(
    () => resolvePrefs(defs, table ? { order: table.order, hidden: table.hidden } : null),
    [defs, table],
  )

  const defMap = useMemo(() => {
    const m = new Map()
    defs.forEach((d) => m.set(d.id, d))
    return m
  }, [defs])

  const visibleIds = useMemo(
    () => prefs.order.filter((id) => !prefs.hidden.includes(id) && defMap.has(id)),
    [prefs, defMap],
  )

  const visibleColumns = useMemo(
    () => visibleIds.map((id) => defMap.get(id)).filter(Boolean),
    [visibleIds, defMap],
  )

  const isVisible = useCallback(
    (id) => visibleIds.includes(id),
    [visibleIds],
  )

  const openCustomize = useCallback(() => setCustomizeOpen(true), [])
  const closeCustomize = useCallback(() => setCustomizeOpen(false), [])

  const savePrefs = useCallback(async (next) => {
    if (!defs.length) {
      toast.error('Column catalog not loaded')
      return
    }
    const resolved = resolvePrefs(defs, next)
    setSaving(true)
    try {
      const res = await settingsAPI.putColumnPref(tableKey, resolved)
      if (res?.tables) {
        setColumnTables(res.tables)
      } else if (res?.table) {
        setColumnTable(tableKey, res.table)
      } else {
        setColumnTable(tableKey, { columns: defs, ...resolved })
      }
      clearLegacyStored(tableKey)
      setCustomizeOpen(false)
    } catch (err) {
      console.error(err)
      toast.error('Could not save column preferences')
    } finally {
      setSaving(false)
    }
  }, [defs, tableKey, setColumnTables, setColumnTable])

  const resetPrefs = useCallback(async () => {
    await savePrefs(defaultPrefsFromDefs(defs))
  }, [defs, savePrefs])

  return {
    defs,
    prefs,
    visibleIds,
    visibleColumns,
    isVisible,
    customizeOpen,
    openCustomize,
    closeCustomize,
    savePrefs,
    resetPrefs,
    saving,
    ready: defs.length > 0,
  }
}
