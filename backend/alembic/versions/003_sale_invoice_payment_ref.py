"""Compatibility marker for the existing payment_ref migration.

The database may already be stamped at this revision while the original
migration file is absent from this checkout. Keep the revision in the graph
so later migrations can be applied safely.
"""

revision = "003_sale_invoice_payment_ref"
down_revision = "002_item_approval_status_enum"
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
