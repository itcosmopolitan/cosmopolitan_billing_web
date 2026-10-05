"""create independent petty cash day-close records

Revision ID: 013_petty_cash_day_closes
Revises: 012_stock_pools
Create Date: 2026-10-05
"""

from alembic import op
import sqlalchemy as sa


revision = "013_petty_cash_day_closes"
down_revision = "012_stock_pools"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if "petty_cash_day_closes" not in sa.inspect(op.get_bind()).get_table_names():
        op.create_table(
            "petty_cash_day_closes",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("branch_id", sa.String(), sa.ForeignKey("branches.id"), nullable=False),
            sa.Column("date", sa.String(), nullable=False),
            sa.Column("opening_balance", sa.Float(), nullable=False, server_default="0"),
            sa.Column("total_cash_in", sa.Float(), nullable=False, server_default="0"),
            sa.Column("total_cash_out", sa.Float(), nullable=False, server_default="0"),
            sa.Column("expected_balance", sa.Float(), nullable=False, server_default="0"),
            sa.Column("physical_count", sa.Float(), nullable=False),
            sa.Column("variance", sa.Float(), nullable=False, server_default="0"),
            sa.Column("variance_reason", sa.Text(), nullable=True),
            sa.Column("notes", sa.Text(), nullable=True),
            sa.Column("closed_by", sa.String(), nullable=False),
            sa.Column("closed_by_id", sa.String(), sa.ForeignKey("users.id"), nullable=True),
            sa.Column("closed_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("unlocked_by", sa.String(), nullable=True),
            sa.Column("unlocked_at", sa.DateTime(), nullable=True),
            sa.Column("unlock_reason", sa.Text(), nullable=True),
            sa.Column("is_locked", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.UniqueConstraint("branch_id", "date", name="uq_petty_cash_day_close_branch_date"),
        )


def downgrade() -> None:
    if "petty_cash_day_closes" in sa.inspect(op.get_bind()).get_table_names():
        op.drop_table("petty_cash_day_closes")
