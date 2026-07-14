"""create itemapprovalstatus enum and convert items.approval_status

Revision ID: 002_item_approval_status_enum
Revises: 001_create_audit_logs
Create Date: 2026-07-14 00:00:00.000000
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = '002_item_approval_status_enum'
down_revision = '001'
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    # Create the enum type if it doesn't exist
    conn.execute(sa.text(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'itemapprovalstatus') THEN
                CREATE TYPE itemapprovalstatus AS ENUM ('draft','pending','pending_approval','approved','rejected','inactive');
            END IF;
        END$$;
        """
    ))

    # Ensure existing values are valid enum labels. Map unknowns to 'draft'.
    valid = ("'draft'", "'pending'", "'pending_approval'", "'approved'", "'rejected'", "'inactive'")
    conn.execute(sa.text(
        "UPDATE items SET approval_status = 'draft' WHERE approval_status IS NULL OR approval_status NOT IN (" + ",".join(valid) + ")"
    ))

    # Drop existing text default (prevents cast error), alter column to the enum type,
    # then set a typed default.
    conn.execute(sa.text("ALTER TABLE items ALTER COLUMN approval_status DROP DEFAULT"))
    conn.execute(sa.text(
        "ALTER TABLE items ALTER COLUMN approval_status TYPE itemapprovalstatus USING approval_status::itemapprovalstatus"
    ))
    conn.execute(sa.text("ALTER TABLE items ALTER COLUMN approval_status SET DEFAULT 'approved'"))


def downgrade() -> None:
    conn = op.get_bind()
    # Convert enum back to text
    conn.execute(sa.text(
        "ALTER TABLE items ALTER COLUMN approval_status TYPE VARCHAR USING approval_status::text"
    ))

    # Drop the enum type if present
    conn.execute(sa.text(
        "DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'itemapprovalstatus') THEN DROP TYPE itemapprovalstatus; END IF; END$$;"
    ))
