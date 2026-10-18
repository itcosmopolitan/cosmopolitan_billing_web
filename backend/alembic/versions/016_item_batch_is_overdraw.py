"""flag oversold placeholder batches

Revision ID: 016_item_batch_is_overdraw
Revises: 015_branch_allow_overselling
Create Date: 2026-10-08
"""

from alembic import op
import sqlalchemy as sa


revision = "016_item_batch_is_overdraw"
down_revision = "015_branch_allow_overselling"
branch_labels = None
depends_on = None


def _column_names(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(table):
        return set()
    return {col["name"] for col in inspector.get_columns(table)}


def upgrade() -> None:
    if not _column_names("item_batches") or "is_overdraw" in _column_names("item_batches"):
        return
    op.add_column(
        "item_batches",
        sa.Column("is_overdraw", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    if "is_overdraw" in _column_names("item_batches"):
        with op.batch_alter_table("item_batches") as batch_op:
            batch_op.drop_column("is_overdraw")
