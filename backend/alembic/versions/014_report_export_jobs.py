"""create report export jobs

Revision ID: 014_report_export_jobs
Revises: 013_petty_cash_day_closes
Create Date: 2026-10-06
"""

from alembic import op
import sqlalchemy as sa


revision = "014_report_export_jobs"
down_revision = "013_petty_cash_day_closes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if "report_export_jobs" not in sa.inspect(op.get_bind()).get_table_names():
        op.create_table(
            "report_export_jobs",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("status", sa.String(), nullable=False, server_default="queued"),
            sa.Column("report_api", sa.String(), nullable=False),
            sa.Column("filename", sa.String(), nullable=False),
            sa.Column("request_json", sa.JSON(), nullable=False),
            sa.Column("file_data", sa.LargeBinary(), nullable=True),
            sa.Column("user_id", sa.String(), sa.ForeignKey("users.id"), nullable=False),
            sa.Column("total_rows", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("processed_rows", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("error_message", sa.Text(), nullable=True),
            sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
            sa.Column("started_at", sa.DateTime(), nullable=True),
            sa.Column("completed_at", sa.DateTime(), nullable=True),
            sa.Column("expires_at", sa.DateTime(), nullable=True),
        )
        op.create_index("ix_report_export_jobs_status", "report_export_jobs", ["status"])
        op.create_index("ix_report_export_jobs_user_id", "report_export_jobs", ["user_id"])
        op.create_index("ix_report_export_jobs_created_at", "report_export_jobs", ["created_at"])
        op.create_index("ix_report_export_jobs_expires_at", "report_export_jobs", ["expires_at"])


def downgrade() -> None:
    if "report_export_jobs" in sa.inspect(op.get_bind()).get_table_names():
        op.drop_table("report_export_jobs")
