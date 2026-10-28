"""persist sales-order line mappings for draft invoices

Revision ID: 018_pending_order_line_mapping
Revises: 017_release_orphaned_so_reservations
Create Date: 2026-10-28
"""

from alembic import op
import sqlalchemy as sa


revision = "018_pending_order_line_mapping"
down_revision = "017_release_orphaned_so_reservations"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("sale_invoices"):
        return
    columns = {column["name"] for column in inspector.get_columns("sale_invoices")}
    if "pending_order_lines" not in columns:
        op.add_column(
            "sale_invoices",
            sa.Column("pending_order_lines", sa.JSON(), nullable=True),
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("sale_invoices"):
        return
    columns = {column["name"] for column in inspector.get_columns("sale_invoices")}
    if "pending_order_lines" in columns:
        op.drop_column("sale_invoices", "pending_order_lines")
