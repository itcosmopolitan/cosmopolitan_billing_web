"""add per-branch transfer overselling setting

Revision ID: 019_branch_transfer_overselling
Revises: 018_pending_order_line_mapping
Create Date: 2026-11-05
"""

from alembic import op
import sqlalchemy as sa


revision = "019_branch_transfer_overselling"
down_revision = "018_pending_order_line_mapping"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("branches"):
        return
    columns = {column["name"] for column in inspector.get_columns("branches")}
    if "allow_transfer_overselling" not in columns:
        op.add_column(
            "branches",
            sa.Column(
                "allow_transfer_overselling",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("branches"):
        return
    columns = {column["name"] for column in inspector.get_columns("branches")}
    if "allow_transfer_overselling" in columns:
        with op.batch_alter_table("branches") as batch_op:
            batch_op.drop_column("allow_transfer_overselling")
