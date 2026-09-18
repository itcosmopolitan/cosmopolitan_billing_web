"""add users.status for invited/active/inactive lifecycle

Revision ID: 010_user_account_status
Revises: 009_create_customer_import_jobs
Create Date: 2026-09-18
"""

from alembic import op
import sqlalchemy as sa


revision = "010_user_account_status"
down_revision = "009_create_customer_import_jobs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "users" not in inspector.get_table_names():
        return
    columns = {col["name"] for col in inspector.get_columns("users")}
    if "status" not in columns:
        op.add_column(
            "users",
            sa.Column(
                "status",
                sa.String(),
                nullable=False,
                server_default="active",
            ),
        )
    op.execute(
        sa.text(
            """
            UPDATE users
            SET status = CASE
                WHEN NOT active THEN 'inactive'
                WHEN must_change_password THEN 'invited'
                ELSE 'active'
            END
            """
        )
    )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "users" not in inspector.get_table_names():
        return
    columns = {col["name"] for col in inspector.get_columns("users")}
    if "status" in columns:
        op.drop_column("users", "status")
