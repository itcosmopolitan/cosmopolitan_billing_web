"""add payment proof metadata to sale invoices

Revision ID: 003_add_payment_proof_metadata
Revises: 002_item_approval_status_enum
Create Date: 2026-09-05 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "004_add_payment_proof_metadata"
down_revision = "003_sale_invoice_payment_ref"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    existing = {column["name"] for column in inspector.get_columns("sale_invoices")}
    columns = (
        ("payment_proof_key", sa.String()),
        ("payment_proof_filename", sa.String()),
        ("payment_proof_content_type", sa.String()),
        ("payment_proof_size", sa.Integer()),
        ("payment_proof_uploaded_at", sa.DateTime()),
        ("payment_proof_uploaded_by", sa.String()),
    )
    for name, column_type in columns:
        if name not in existing:
            op.add_column("sale_invoices", sa.Column(name, column_type, nullable=True))


def downgrade() -> None:
    op.drop_column("sale_invoices", "payment_proof_uploaded_by")
    op.drop_column("sale_invoices", "payment_proof_uploaded_at")
    op.drop_column("sale_invoices", "payment_proof_size")
    op.drop_column("sale_invoices", "payment_proof_content_type")
    op.drop_column("sale_invoices", "payment_proof_filename")
    op.drop_column("sale_invoices", "payment_proof_key")