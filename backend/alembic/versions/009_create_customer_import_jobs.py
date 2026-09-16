"""create durable customer import jobs

Revision ID: 009_create_customer_import_jobs
Revises: 007_create_item_import_jobs
Create Date: 2026-09-17
"""

from alembic import op
import sqlalchemy as sa


revision = "009_create_customer_import_jobs"
down_revision = "007_create_item_import_jobs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table("customer_import_jobs"):
        return

    op.create_table(
        "customer_import_jobs",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("status", sa.String(), nullable=False, server_default="queued"),
        sa.Column("filename", sa.String(), nullable=False),
        sa.Column("file_data", sa.LargeBinary(), nullable=False),
        sa.Column("user_id", sa.String(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("branch_id", sa.String(), nullable=False),
        sa.Column("total_rows", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("processed_rows", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("skipped_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("errors", sa.JSON(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
    )
    op.create_index("ix_customer_import_jobs_status", "customer_import_jobs", ["status"])
    op.create_index("ix_customer_import_jobs_user_id", "customer_import_jobs", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_customer_import_jobs_user_id", table_name="customer_import_jobs")
    op.drop_index("ix_customer_import_jobs_status", table_name="customer_import_jobs")
    op.drop_table("customer_import_jobs")
