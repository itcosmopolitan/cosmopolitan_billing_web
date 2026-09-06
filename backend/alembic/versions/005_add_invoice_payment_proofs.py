"""add multiple payment proofs per invoice

Revision ID: 005_add_invoice_payment_proofs
Revises: 004_add_payment_proof_metadata
Create Date: 2026-09-06 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "005_add_invoice_payment_proofs"
down_revision = "004_add_payment_proof_metadata"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("invoice_payment_proofs"):
        op.create_table(
            "invoice_payment_proofs",
            sa.Column("id", sa.String(), primary_key=True),
            sa.Column("invoice_id", sa.String(), sa.ForeignKey("sale_invoices.id"), nullable=False),
            sa.Column("payment_ref", sa.String(), nullable=True),
            sa.Column("object_key", sa.String(), nullable=False, unique=True),
            sa.Column("filename", sa.String(), nullable=False),
            sa.Column("content_type", sa.String(), nullable=False),
            sa.Column("size", sa.Integer(), nullable=False),
            sa.Column("uploaded_at", sa.DateTime(), nullable=False),
            sa.Column("uploaded_by", sa.String(), nullable=True),
        )
        op.create_index(
            "ix_invoice_payment_proofs_invoice_id",
            "invoice_payment_proofs",
            ["invoice_id"],
        )
    # Preserve proofs created before the table existed.
    op.execute(sa.text("""
        INSERT INTO invoice_payment_proofs
            (id, invoice_id, payment_ref, object_key, filename, content_type,
             size, uploaded_at, uploaded_by)
        SELECT md5(payment_proof_key), id, payment_ref, payment_proof_key,
               COALESCE(payment_proof_filename, 'payment-proof'),
               COALESCE(payment_proof_content_type, 'application/octet-stream'),
               COALESCE(payment_proof_size, 0),
               COALESCE(payment_proof_uploaded_at, CURRENT_TIMESTAMP),
               payment_proof_uploaded_by
        FROM sale_invoices
        WHERE payment_proof_key IS NOT NULL
        ON CONFLICT (object_key) DO NOTHING
    """))


def downgrade() -> None:
    op.drop_index("ix_invoice_payment_proofs_invoice_id", table_name="invoice_payment_proofs")
    op.drop_table("invoice_payment_proofs")