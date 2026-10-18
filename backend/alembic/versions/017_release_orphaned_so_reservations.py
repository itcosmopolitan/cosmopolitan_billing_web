"""release active reservations left behind by deleted sales orders

Revision ID: 017_release_orphaned_so_reservations
Revises: 016_item_batch_is_overdraw
Create Date: 2026-10-18
"""

from alembic import op
import sqlalchemy as sa


revision = "017_release_orphaned_so_reservations"
down_revision = "016_item_batch_is_overdraw"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("stock_reservations") or not inspector.has_table("sales_orders"):
        return
    op.execute(
        "UPDATE stock_reservations SET status = 'released' "
        "WHERE status = 'active' AND source_type = 'sales_order' "
        "AND source_ref NOT IN (SELECT id FROM sales_orders)"
    )


def downgrade() -> None:
    pass
