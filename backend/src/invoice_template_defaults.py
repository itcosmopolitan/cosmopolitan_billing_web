"""Default invoice template settings (Settings → Invoice Template)."""

DEFAULT_INVOICE_TEMPLATE_ID = "inv-tpl-default"

DEFAULT_INVOICE_TEMPLATE: dict = {
    "id": DEFAULT_INVOICE_TEMPLATE_ID,
    "header_style": "full",
    "show_attr": True,
    "show_size": True,
    "show_disc": True,
    "show_hsn": False,
    "tax_mode": "total",
    "show_customer": True,
    "show_payment": True,
    "show_printed_date": True,
    "show_store": True,
    "show_cashier": True,
    "footer_msg": "Thank you for shopping with us! Champa brothers",
    "footer_note": "Goods once sold will not be taken back",
}

VALID_HEADER_STYLES = ("full", "nameonly", "logo")
VALID_TAX_MODES = ("total", "itemized")

LEGACY_HEADER_STYLES = {
    "name_and_logo": "full",
    "logo_only": "logo",
    "name_only": "nameonly",
}
LEGACY_TAX_DISPLAY = {
    "cgst_sgst": "itemized",
    "igst": "itemized",
    "total_only": "total",
}
