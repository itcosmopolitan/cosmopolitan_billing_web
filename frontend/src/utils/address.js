export function composeAddress({ street1, street2, street3, city, stateProvince, country, postalCode }) {
  const parts = [street1, street2, street3, city, stateProvince, country, postalCode]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
  return parts.join(', ')
}

export function childCounterInvoiceAddress(branch, sale) {
  const counterId = sale?.childCounterId || sale?.child_counter_id
  const counterName = sale?.childCounterName || sale?.child_counter_name
  if (!counterId && !counterName) return null

  const counters = branch?.child_counters || branch?.childCounters
  const counter = (Array.isArray(counters) ? counters : []).find((candidate) => (
    (counterId && candidate.id === counterId) ||
    (!counterId && counterName && candidate.name === counterName)
  ))
  if (!counter) return []

  const street = [
    counter.street1 || counter.street_1,
    counter.street2 || counter.street_2,
    counter.street3 || counter.street_3,
  ].filter((part) => typeof part === 'string' && part.trim()).map((part) => part.trim()).join(', ')
  const locality = [
    counter.city,
    counter.stateProvince || counter.state_province,
    counter.country || counter.country_name || counter.countryName,
    counter.postalCode || counter.postal_code,
  ].filter((part) => typeof part === 'string' && part.trim()).map((part) => part.trim()).join(', ')
  const addressLines = [street, locality].filter(Boolean)
  if (addressLines.length) return addressLines

  return typeof counter.address === 'string' && counter.address.trim()
    ? [counter.address.trim()]
    : []
}

export function decomposeAddress(address) {
  if (!address || typeof address !== 'string') {
    return {
      street1: '',
      street2: '',
      street3: '',
      city: '',
      stateProvince: '',
      country: '',
      postalCode: '',
    }
  }

  const parts = address.split(',').map((part) => part.trim()).filter(Boolean)
  switch (parts.length) {
    case 1:
      return {
        street1: parts[0],
        street2: '',
        street3: '',
        city: '',
        stateProvince: '',
        country: '',
        postalCode: '',
      }
    case 2:
      return {
        street1: parts[0],
        street2: '',
        street3: '',
        city: parts[1],
        stateProvince: '',
        country: '',
        postalCode: '',
      }
    case 3:
      return {
        street1: parts[0],
        street2: '',
        street3: '',
        city: parts[1],
        stateProvince: '',
        country: parts[2],
        postalCode: '',
      }
    case 4:
      return {
        street1: parts[0],
        street2: '',
        street3: '',
        city: parts[1],
        stateProvince: parts[2],
        country: parts[3],
        postalCode: '',
      }
    case 5:
      return {
        street1: parts[0],
        street2: parts[1],
        street3: '',
        city: parts[2],
        stateProvince: parts[3],
        country: parts[4],
        postalCode: '',
      }
    case 6:
      return {
        street1: parts[0],
        street2: parts[1],
        street3: parts[2],
        city: parts[3],
        stateProvince: parts[4],
        country: parts[5],
        postalCode: '',
      }
    default:
      return {
        street1: parts[0],
        street2: parts[1] || '',
        street3: parts[2] || '',
        city: parts[3] || '',
        stateProvince: parts[4] || '',
        country: parts[5] || '',
        postalCode: parts.slice(6).join(', '),
      }
  }
}
