/** Item discount / fixed-price pattern × customer pricing category helpers. */

import { priceTaxBreakdown } from '@/utils/taxCalc'
import { roundAmount } from '@/utils/decimalPrecision'

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

export function customerClassification(customerOrValue) {
  if (customerOrValue == null) return 'external'
  if (typeof customerOrValue === 'string') {
    const v = customerOrValue.trim().toLowerCase()
    return v === 'internal' ? 'internal' : 'external'
  }
  const v = (
    customerOrValue.classification
    || customerOrValue.customerClassification
    || ''
  ).toString().trim().toLowerCase()
  return v === 'internal' ? 'internal' : 'external'
}

export function isInternalCustomer(customerOrValue) {
  return customerClassification(customerOrValue) === 'internal'
}

/**
 * Charge GST-exclusive unit price for internal customers.
 * Catalog amounts stay inclusive; GST is subtracted from the line amount.
 */
export function linePricingForCustomer(inclusivePrice, taxRate, customerOrValue) {
  const inclusive = Math.max(0, Number(inclusivePrice) || 0)
  const catalogRate = Number(taxRate) || 0
  if (!isInternalCustomer(customerOrValue) || catalogRate <= 0 || inclusive <= 0) {
    return {
      price: inclusive,
      taxRate: catalogRate,
      catalogTaxRate: catalogRate,
      catalogInclusivePrice: inclusive,
      gstReversed: 0,
    }
  }
  const { exclusive, tax } = priceTaxBreakdown(inclusive, 'inclusive', catalogRate)
  return {
    price: exclusive,
    taxRate: 0,
    catalogTaxRate: catalogRate,
    catalogInclusivePrice: inclusive,
    gstReversed: tax,
  }
}

export function taxRateForCustomer(rate, customerOrValue) {
  if (isInternalCustomer(customerOrValue)) return 0
  const n = Number(rate)
  return Number.isFinite(n) ? n : 0
}

export function applyInternalGstToSaleLines(items, customerOrValue) {
  return (items || []).map((it) => {
    if (!it?.item_id && !it?.itemId) return it
    const rate = Number(it.catalogTaxRate ?? it.taxRate) || 0
    const inclusive = Number(it.price) || 0
    return { ...it, ...linePricingForCustomer(inclusive, rate, customerOrValue) }
  })
}

/** Document-level GST reverse: catalog incl. − GST = amount charged. */
export function internalGstReverseSummary(items) {
  let gstReversed = 0
  let inclusive = 0
  let exclusive = 0
  const rates = new Set()
  for (const it of items || []) {
    const qty = Number(it.qty) || 0
    const rate = Number(it.catalogTaxRate) || 0
    const unitGst = Number(it.gstReversed) || 0
    const inclUnit = Number(it.catalogInclusivePrice) || 0
    const exclUnit = Number(it.price) || 0
    if (!(qty > 0 && rate > 0 && (unitGst > 0 || (inclUnit > exclUnit)))) continue
    const gst = unitGst > 0 ? unitGst : roundAmount(inclUnit - exclUnit)
    const incl = inclUnit > 0 ? inclUnit : roundAmount(exclUnit + gst)
    inclusive += incl * qty
    exclusive += exclUnit * qty
    gstReversed += gst * qty
    rates.add(rate)
  }
  return {
    gstReversed: roundAmount(gstReversed),
    inclusive: roundAmount(inclusive),
    exclusive: roundAmount(exclusive),
    rate: rates.size === 1 ? [...rates][0] : null,
  }
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

/** Pricing-category discounts plus internal-customer GST reverse. */
export function applyCustomerPricingToSaleLines(items, customer) {
  return applyInternalGstToSaleLines(
    applySuggestedDiscountsToSaleLines(items, customer),
    customer,
  )
}
