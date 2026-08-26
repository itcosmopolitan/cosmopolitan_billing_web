/** Item discount / fixed-price pattern × customer pricing category helpers. */

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

export function normalizeCategoryPricingMode(mode) {
  return String(mode || '').trim().toLowerCase() === 'price' ? 'price' : 'pct'
}

function num(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** Copy category-pricing fields from an inventory/API item onto a cart/line row. */
export function discountPatternFromItem(inv) {
  const retail = num(
    inv?.retailPrice
      ?? inv?.selling_price
      ?? inv?.sellingPrice
      ?? inv?.default_selling_price
      ?? inv?.price,
  )
  return {
    retailPrice: retail,
    wholesale_pricing_mode: normalizeCategoryPricingMode(
      inv?.wholesale_pricing_mode ?? inv?.wholesalePricingMode,
    ),
    wholesale_discount_pct: Math.max(0, num(inv?.wholesale_discount_pct ?? inv?.wholesaleDiscountPct)),
    wholesale_price: Math.max(0, num(inv?.wholesale_price ?? inv?.wholesalePrice)),
    staff_pricing_mode: normalizeCategoryPricingMode(
      inv?.staff_pricing_mode ?? inv?.staffPricingMode,
    ),
    staff_discount_pct: Math.max(0, num(inv?.staff_discount_pct ?? inv?.staffDiscountPct)),
    staff_price: Math.max(0, num(inv?.staff_price ?? inv?.staffPrice)),
  }
}

/**
 * Resolve unit rate + suggested line discount % for a customer pricing category.
 * Fixed-price mode sets the item rate itself (no discount); % mode keeps retail rate.
 */
export function resolveCategoryLinePricing(item, customerOrType) {
  const type = customerPricingType(customerOrType)
  const pattern = discountPatternFromItem(item)
  const retail = pattern.retailPrice

  if (type === 'wholesale') {
    if (pattern.wholesale_pricing_mode === 'price' && pattern.wholesale_price > 0) {
      return { price: pattern.wholesale_price, discountPct: 0, mode: 'price' }
    }
    return { price: retail, discountPct: pattern.wholesale_discount_pct, mode: 'pct' }
  }
  if (type === 'staff') {
    if (pattern.staff_pricing_mode === 'price' && pattern.staff_price > 0) {
      return { price: pattern.staff_price, discountPct: 0, mode: 'price' }
    }
    return { price: retail, discountPct: pattern.staff_discount_pct, mode: 'pct' }
  }
  return { price: retail, discountPct: 0, mode: 'pct' }
}

/** Suggested line discount % from item pattern + customer pricing category. */
export function suggestedDiscountForCustomer(item, customerOrType) {
  return resolveCategoryLinePricing(item, customerOrType).discountPct
}

/**
 * Prefill sales-document line rate + discount from the item pattern for the
 * given customer pricing category. Empty / unset lines are left alone.
 */
export function applySuggestedDiscountsToSaleLines(items, customerOrType) {
  const type = customerPricingType(customerOrType)
  return (items || []).map((it) => {
    if (!it?.item_id && !it?.itemId) return it
    const pattern = discountPatternFromItem(it)
    const resolved = resolveCategoryLinePricing({ ...it, ...pattern }, type)
    return {
      ...it,
      ...pattern,
      price: resolved.price,
      lineDiscount: resolved.discountPct,
      lineDiscountType: '%',
    }
  })
}
