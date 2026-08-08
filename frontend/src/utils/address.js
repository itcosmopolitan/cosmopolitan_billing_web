export function composeAddress({ street1, street2, street3, city, stateProvince, country, postalCode }) {
  const parts = [street1, street2, street3, city, stateProvince, country, postalCode]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
  return parts.join(', ')
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
