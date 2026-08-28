"""Default GST rates seeded on boot and via seed.py."""

DEFAULT_TAX_RATES: list[tuple[str, float, str, str, bool]] = [
    (
        "tax-0",
        0.0,
        "Exempt (0%)",
        "Essential goods, fresh produce, unprocessed staples",
        True,
    ),
    (
        "tax-8",
        8.0,
        "GST 8%",
        "Standard taxable goods and provisions",
        True,
    ),
]