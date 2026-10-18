const ARROW_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']
const DECIMAL_KEY = /^[0-9.]$/
const FIELD_SELECTOR = 'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])'

function fieldIn(cell) {
  return cell ? cell.querySelector(FIELD_SELECTOR) : null
}

// Inputs without a caret API (e.g. date, checkbox) always navigate.
function caretAtEdge(input, key) {
  if (typeof input.selectionStart !== 'number') return true
  const { selectionStart: start, selectionEnd: end, value } = input
  if (key === 'ArrowLeft') return start === 0 && end === 0
  return start === value.length && end === value.length
}

function findHorizontal(row, col, step) {
  for (let c = col + step; c >= 0 && c < row.cells.length; c += step) {
    const field = fieldIn(row.cells[c])
    if (field) return field
  }
  return null
}

function findVertical(body, row, col, step) {
  const rows = Array.from(body.rows)
  for (let r = rows.indexOf(row) + step; r >= 0 && r < rows.length; r += step) {
    const field = fieldIn(rows[r].cells[col])
    if (field) return field
  }
  return null
}

export function handleGridArrowKeyDown(e) {
  // Decimal cells are text inputs, so block non-numeric characters here.
  if (e.target?.inputMode === 'decimal' && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !DECIMAL_KEY.test(e.key)) {
    e.preventDefault()
    return
  }

  if (!ARROW_KEYS.includes(e.key) || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return

  const input = e.target
  if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement || input instanceof HTMLSelectElement)) return

  const cell = input.closest('td')
  const row = cell?.parentElement
  const body = row?.parentElement
  if (!cell || !row || !body) return

  const vertical = e.key === 'ArrowUp' || e.key === 'ArrowDown'
  if (vertical) {
    // Prevents number spinners from changing the value while moving rows.
    e.preventDefault()
    const step = e.key === 'ArrowUp' ? -1 : 1
    findVertical(body, row, cell.cellIndex, step)?.focus()
    return
  }

  if (!caretAtEdge(input, e.key)) return
  const step = e.key === 'ArrowLeft' ? -1 : 1
  const target = findHorizontal(row, cell.cellIndex, step)
  if (!target) return
  e.preventDefault()
  target.focus()
}
