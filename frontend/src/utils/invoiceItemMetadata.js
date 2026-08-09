function getFirstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value
    }
  }
  return ''
}

function toPackagingValue(item, nestedItem) {
  const packagingQty = getFirstDefined(
    item?.packaging_quantity,
    item?.packagingQty,
    nestedItem?.packaging_quantity,
    nestedItem?.packagingQty,
  )

  if (packagingQty !== '') {
    return packagingQty
  }

  const isPackaging = getFirstDefined(
    item?.is_packaging,
    nestedItem?.is_packaging,
  )

  if (isPackaging === true) {
    return 'Yes'
  }

  return getFirstDefined(
    item?.packing,
    item?.packaging,
    item?.package,
    item?.size,
    nestedItem?.packing,
    nestedItem?.packaging,
    nestedItem?.package,
    nestedItem?.size,
  )
}

export function getInvoiceItemMetadata(item) {
  const nestedItem = item?.item || item?.product || item?.catalogItem || item?.itemData || {}

  return {
    packaging: toPackagingValue(item, nestedItem),
    origin: getFirstDefined(
      item?.origin,
      item?.country_of_origin,
      item?.country,
      item?.manufacturer,
      nestedItem?.origin,
      nestedItem?.country_of_origin,
      nestedItem?.country,
      nestedItem?.manufacturer,
    ),
    units: getFirstDefined(
      item?.units,
      item?.unit,
      nestedItem?.units,
      nestedItem?.unit,
    ),
  }
}

export function resolveInvoiceItemField(item, field) {
  const metadata = getInvoiceItemMetadata(item)

  switch (field) {
    case 'packing':
      return metadata.packaging
    case 'origin':
      return metadata.origin
    case 'units':
      return metadata.units
    default:
      return ''
  }
}
