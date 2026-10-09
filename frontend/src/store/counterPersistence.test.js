import { beforeEach, describe, expect, it, vi } from 'vitest'

function createLocalStorage() {
  const data = new Map()
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    clear: () => data.clear(),
  }
}

async function loadStore() {
  vi.resetModules()
  return import('@/store')
}

describe('selected child counter persistence', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createLocalStorage())
  })

  it('writes the selected counter and its branch to localStorage', async () => {
    const { usePOSStore } = await loadStore()
    usePOSStore.getState().setChildCounterBranchId('br-1')
    usePOSStore.getState().setSelectedChildCounter('cc-1')

    const persisted = JSON.parse(localStorage.getItem('retailos-pos')).state
    expect(persisted.selectedChildCounter).toBe('cc-1')
    expect(persisted.childCounterBranchId).toBe('br-1')
  })

  it('restores the counter after a reload', async () => {
    const { usePOSStore } = await loadStore()
    usePOSStore.getState().setChildCounterBranchId('br-1')
    usePOSStore.getState().setSelectedChildCounter('cc-1')

    const { usePOSStore: reloaded } = await loadStore()
    expect(reloaded.getState().selectedChildCounter).toBe('cc-1')
    expect(reloaded.getState().childCounterBranchId).toBe('br-1')
  })

  it('keeps the counter when the same branch context is re-applied', async () => {
    const { usePOSStore } = await loadStore()
    usePOSStore.getState().setChildCounterBranchId('br-1')
    usePOSStore.getState().setSelectedChildCounter('cc-1')
    usePOSStore.getState().setChildCounterBranchId('br-1')

    expect(usePOSStore.getState().selectedChildCounter).toBe('cc-1')
  })

  it('clears the counter when the branch actually changes', async () => {
    const { usePOSStore } = await loadStore()
    usePOSStore.getState().setChildCounterBranchId('br-1')
    usePOSStore.getState().setSelectedChildCounter('cc-1')
    usePOSStore.getState().setChildCounterBranchId('br-2')

    expect(usePOSStore.getState().selectedChildCounter).toBe('')
  })
})
