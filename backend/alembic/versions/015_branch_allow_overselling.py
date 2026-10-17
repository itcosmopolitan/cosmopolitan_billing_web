"""move allow_overselling from organisation to branches

Revision ID: 015_branch_allow_overselling
Revises: 014_report_export_jobs
Create Date: 2026-10-07
"""

from alembic import op
import sqlalchemy as sa


revision = "015_branch_allow_overselling"
down_revision = "014_report_export_jobs"
branch_labels = None
depends_on = None


def _column_names(table: str) -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(table):
        return set()
    return {col["name"] for col in inspector.get_columns(table)}


def upgrade() -> None:
    if "allow_overselling" in _column_names("branches"):
        return
    op.add_column(
        "branches",
        sa.Column("allow_overselling", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    if "allow_overselling" in _column_names("organisations"):
        legacy = "(SELECT allow_overselling FROM organisations LIMIT 1)"
    else:
        legacy = ":default"
    op.execute(
        sa.text(f"UPDATE branches SET allow_overselling = COALESCE({legacy}, :default)")
        .bindparams(default=True)
    )


def downgrade() -> None:
    if "allow_overselling" in _column_names("branches"):
        with op.batch_alter_table("branches") as batch_op:
            batch_op.drop_column("allow_overselling")
