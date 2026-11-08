const GST_INCLUSIVE_SALES_REGISTER_LABELS = {
  net_amount: 'Net Amount (Incl. GST)',
  paid_amount: 'Payment Paid (Incl. GST)',
  remaining_amount: 'Balance Due (Incl. GST)',
}

export function salesRegisterColumnLabel(column) {
  return GST_INCLUSIVE_SALES_REGISTER_LABELS[column.key] || null
}
