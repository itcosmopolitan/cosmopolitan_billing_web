from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

# Lazy engine initialization to support config loading
_engine = None

def get_engine():
    """Initialize and return the database engine"""
    global _engine
    if _engine is None:
        from src import config
        database_url = config.get().database_url
        _engine = create_async_engine(database_url, echo=False)
    return _engine

def get_async_session():
    """Get SQLAlchemy async session factory"""
    return sessionmaker(
        get_engine(), class_=AsyncSession, expire_on_commit=False
    )

class Base(DeclarativeBase):
    pass

async def get_db():
    async_session = get_async_session()
    async with async_session() as session:
        try:
            yield session
        finally:
            await session.close()


# ─── Boot-time schema bootstrap ──────────────────────────────────────────────
# `Base.metadata.create_all` only adds tables, never columns to existing
# tables. We need to add `users.role_id` to databases that already exist
# from before the Users & Roles work. The repo doesn't use Alembic yet
# (see CLAUDE.md "Gotchas"), so this hybrid step keeps demo databases
# working without forcing a destructive `npm run seed`.
#
# Everything here is idempotent — safe to run on every boot.
# Drop these helpers once Alembic is introduced in Phase 3.

# (table, column, ddl_type) — ddl_type is what SQLite ALTER TABLE expects.
_ADDITIVE_COLUMNS: list[tuple[str, str, str]] = [
    ("users", "role_id", "VARCHAR"),
    # Force-password-change-on-first-login flag (added 2026-05-18 with the
    # admin Add User redesign). Existing users default to 0 (false) so the
    # migration doesn't disrupt anyone; new users created via POST /users/
    # explicitly get 1 (true) until they self-change via /auth/change-password.
    ("users", "must_change_password", "BOOLEAN DEFAULT 0 NOT NULL"),
    # Multi-branch user assignment (added 2026-05-18 with the Add User
    # multi-select). When 1, the user has access to all branches and the
    # `user_branches` join is empty. The `user_branches` table itself is
    # created by Base.metadata.create_all() in init_schema() — no DDL entry
    # needed here for new tables, only for additive columns on existing ones.
    ("users", "all_branches", "BOOLEAN DEFAULT 0 NOT NULL"),
]

# Map legacy users.role enum values → seeded roles.id from seed.py SYSTEM_ROLES.
LEGACY_ROLE_TO_ID: dict[str, str] = {
    "super_admin":       "role-super-admin",
    "branch_manager":    "role-branch-manager",
    "cashier":           "role-cashier",
    "inventory_manager": "role-inventory-manager",
    "finance":           "role-finance",
    "purchase_admin":    "role-purchase-admin",
}


async def init_schema() -> None:
    """Create tables, then apply additive column migrations and the role-id
    backfill (D6). Called from main.py startup after Base.metadata.create_all.
    """
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await _ensure_columns(conn)
        await _bootstrap_system_roles(conn)
        await _backfill_role_ids(conn)


async def _bootstrap_system_roles(conn) -> None:
    """Idempotently insert the 6 system roles (D6). Lets demo databases that
    weren't re-seeded after this PR still pick up the new RBAC tables.
    A re-seed via seed.py drops everything first, so there's no conflict."""
    # Local import avoids a top-level cycle (system_roles is a leaf module).
    import json

    from src.system_roles import SYSTEM_ROLES

    rows = (await conn.execute(text("SELECT id FROM roles"))).fetchall()
    existing = {r[0] for r in rows}
    for rid, key, label, color, description, perms in SYSTEM_ROLES:
        if rid in existing:
            continue
        await conn.execute(
            text(
                "INSERT INTO roles (id, key, label, description, color, permissions, is_system, active) "
                "VALUES (:id, :key, :label, :desc, :color, :perms, 1, 1)"
            ),
            {
                "id": rid,
                "key": key,
                "label": label,
                "desc": description,
                "color": color,
                # JSON column on SQLite is stored as TEXT; serialize ourselves
                # because we're using raw SQL here, not the ORM.
                "perms": json.dumps(perms),
            },
        )


async def _ensure_columns(conn) -> None:
    """For SQLite, add any missing columns from `_ADDITIVE_COLUMNS`. No-op on
    columns that already exist."""
    for table, column, ddl_type in _ADDITIVE_COLUMNS:
        rows = (await conn.execute(text(f"PRAGMA table_info({table})"))).fetchall()
        existing = {r[1] for r in rows}  # row[1] = column name
        if column in existing:
            continue
        await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl_type}"))


async def _backfill_role_ids(conn) -> None:
    """For users with a non-null legacy `role` enum but a null `role_id`,
    fill `role_id` with the matching seeded system role's id (D6).
    Skips silently if the `roles` table is empty (e.g. first boot before
    seed.py has been run)."""
    has_any_roles = (await conn.execute(text("SELECT COUNT(*) FROM roles"))).scalar() or 0
    if not has_any_roles:
        return
    for legacy_role, role_id in LEGACY_ROLE_TO_ID.items():
        await conn.execute(
            text("UPDATE users SET role_id = :rid WHERE role_id IS NULL AND role = :lr"),
            {"rid": role_id, "lr": legacy_role},
        )
