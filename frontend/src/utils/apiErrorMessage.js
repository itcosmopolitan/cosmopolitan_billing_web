/**
 * Turn an API error into a string that is safe to pass to toast.error().
 *
 * FastAPI `detail` can be a string, a list of validation errors (422), or a
 * structured object (e.g. 409 stock conflicts). Rendering the raw object as a
 * toast child crashes React, so resolve it to a readable message here.
 */
export function apiErrorMessage(err, fallback = 'Request failed') {
  const detail = err?.response?.data?.detail
  if (typeof detail === 'string' && detail.trim()) return detail
  if (Array.isArray(detail)) {
    const messages = detail
      .map((entry) => entry?.msg)
      .filter((msg) => typeof msg === 'string' && msg)
    if (messages.length) return messages.join('. ')
  }
  if (detail && typeof detail === 'object' && typeof detail.message === 'string' && detail.message) {
    return detail.message
  }
  return fallback
}
