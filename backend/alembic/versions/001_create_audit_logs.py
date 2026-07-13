"""create or align audit_logs table

Revision ID: 001
Revises:
Create Date: 2026-06-27
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect
from sqlalchemy.dialects import postgresql


revision = "001"
down_revision = None
branch_labels = None
depends_on = None


def _column_exists(columns: list[dict], name: str) -> bool:
    return any(col["name"] == name for col in columns)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)

    has_table = inspector.has_table("audit_logs")

    if not has_table:
        op.create_table(
            "audit_logs",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("action", sa.String(length=100), nullable=False),
            sa.Column("user_id", sa.String(), nullable=True),
            sa.Column("user_name", sa.String(length=100), nullable=False, server_default="System"),
            sa.Column("user_role", sa.String(length=50), nullable=False, server_default="unknown"),
            sa.Column("module", sa.String(length=50), nullable=False),
            sa.Column("reference_id", sa.String(length=100), nullable=False, server_default="-"),
            sa.Column("ref", sa.String(), nullable=True),
            sa.Column("detail", sa.Text(), nullable=False),
            sa.Column("risk", sa.String(length=10), nullable=False, server_default="LOW"),
            sa.Column("ip_address", sa.String(length=45), nullable=True),
            sa.Column("device_info", sa.String(length=200), nullable=True),
            sa.Column("branch_id", sa.String(), nullable=True),
            sa.Column("metadata", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
            sa.Column("record_type", sa.String(), nullable=True),
            sa.Column("record_id", sa.String(), nullable=True),
            sa.Column("event_type", sa.String(), nullable=True),
            sa.Column("event_metadata", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        )

    columns = inspector.get_columns("audit_logs")

    if not _column_exists(columns, "user_role"):
        op.add_column("audit_logs", sa.Column("user_role", sa.String(length=50), nullable=True))
        op.execute("UPDATE audit_logs SET user_role = 'unknown' WHERE user_role IS NULL")
        op.alter_column("audit_logs", "user_role", nullable=False)

    if not _column_exists(columns, "reference_id"):
        op.add_column("audit_logs", sa.Column("reference_id", sa.String(length=100), nullable=True))
        if _column_exists(columns, "ref"):
            op.execute("UPDATE audit_logs SET reference_id = COALESCE(ref, '-') WHERE reference_id IS NULL")
        else:
            op.execute("UPDATE audit_logs SET reference_id = '-' WHERE reference_id IS NULL")
        op.alter_column("audit_logs", "reference_id", nullable=False)

    if not _column_exists(columns, "device_info"):
        op.add_column("audit_logs", sa.Column("device_info", sa.String(length=200), nullable=True))

    if not _column_exists(columns, "branch_id"):
        op.add_column("audit_logs", sa.Column("branch_id", sa.String(), nullable=True))

    if not _column_exists(columns, "metadata"):
        op.add_column("audit_logs", sa.Column("metadata", postgresql.JSONB(astext_type=sa.Text()), nullable=True))

    indexes = {idx["name"] for idx in inspector.get_indexes("audit_logs")}

    if "idx_audit_logs_created_at" not in indexes:
        op.create_index("idx_audit_logs_created_at", "audit_logs", ["created_at"])
    if "idx_audit_logs_module" not in indexes:
        op.create_index("idx_audit_logs_module", "audit_logs", ["module"])
    if "idx_audit_logs_risk" not in indexes:
        op.create_index("idx_audit_logs_risk", "audit_logs", ["risk"])
    if "idx_audit_logs_user_id" not in indexes:
        op.create_index("idx_audit_logs_user_id", "audit_logs", ["user_id"])
    if "idx_audit_logs_branch_id" not in indexes:
        op.create_index("idx_audit_logs_branch_id", "audit_logs", ["branch_id"])
    if "idx_audit_logs_reference_id" not in indexes:
        op.create_index("idx_audit_logs_reference_id", "audit_logs", ["reference_id"])

    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_audit_logs_fts "
        "ON audit_logs USING GIN (to_tsvector('english', coalesce(action,'') || ' ' || coalesce(detail,'')))"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_audit_logs_fts")
    for idx_name in (
        "idx_audit_logs_reference_id",
        "idx_audit_logs_branch_id",
        "idx_audit_logs_user_id",
        "idx_audit_logs_risk",
        "idx_audit_logs_module",
        "idx_audit_logs_created_at",
    ):
        op.execute(f"DROP INDEX IF EXISTS {idx_name}")
