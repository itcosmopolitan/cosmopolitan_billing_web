/** Item discount pattern × customer pricing category helpers. */

export function customerPricingType(customerOrType) {
  if (customerOrType == null) return 'retail'
  if (typeof customerOrType === 'string') return customerOrType.trim().toLowerCase() || 'retail'
  return (
    customerOrType.customer_type
    || customerOrType.customerType
    || customerOrType.type
    || 'retail'
  ).toString().trim().toLowerCase() || 'retail'
}

/** Suggested line discount % from item pattern + customer pricing category. */
export function suggestedDiscountForCustomer(item, customerOrType) {
  const type = customerPricingType(customerOrType)
  if (type === 'wholesale') return Math.max(0, Number(item?.wholesale_discount_pct ?? item?.wholesaleDiscountPct ?? 0))
  if (type === 'staff') return Math.max(0, Number(item?.staff_discount_pct ?? item?.staffDiscountPct ?? 0))
  return 0
}

/** Copy discount-pattern fields from an inventory/API item onto a cart/line row. */
export function discountPatternFromItem(inv) {
  return {
    wholesale_discount_pct: Number(inv?.wholesale_discount_pct ?? inv?.wholesaleDiscountPct ?? 0) || 0,
    staff_discount_pct: Number(inv?.staff_discount_pct ?? inv?.staffDiscountPct ?? 0) || 0,
  }
}

/**
 * Prefill sales-document line discounts (%) from the item pattern for the
 * given customer pricing category. Empty / unset lines are left alone.
 */
export function applySuggestedDiscountsToSaleLines(items, customerOrType) {
  const type = customerPricingType(customerOrType)
  return (items || []).map((it) => {
    if (!it?.item_id && !it?.itemId) return it
    return {
      ...it,
      ...discountPatternFromItem(it),
      lineDiscount: suggestedDiscountForCustomer(it, type),
      lineDiscountType: '%',
    }
  })
}
