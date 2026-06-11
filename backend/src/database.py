import asyncio
import logging
import os
import socket
import ssl
import time

from sqlalchemy import event, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from sqlalchemy.pool import NullPool

# Lazy engine/sessionmaker initialization to support config loading
_engine = None
logger = logging.getLogger("cosmopolitan.database")
_async_sessionmaker = None

def get_engine():
    """Initialize and return the database engine
    
    Note: SQLAlchemy async engines only support NullPool.
    Connection pooling for PostgreSQL is handled by the asyncpg driver.
    Connection pooling for SQLite is not applicable (not async-compatible).
    """
    global _engine
    if _engine is None:
        from src import config
        database_url = config.get().database_url.strip()
        url = _validate_database_url(database_url)
        engine_url = url

        # AsyncIO engines don't support QueuePool - use NullPool for both databases
        # PostgreSQL: asyncpg driver handles connection pooling internally
        # SQLite: Not properly async-compatible, use NullPool
        engine_kwargs = {
            "echo": False,
        }

        # Configure connection/query timeouts and pooling for PostgreSQL.
        is_postgres = url.drivername in ("postgresql", "postgresql+asyncpg")

        if is_postgres:
            engine_kwargs.update(
                {
                    "pool_size": 5,
                    "max_overflow": 10,
                    "pool_timeout": 20,
                    "pool_recycle": 1800,
                    "pool_pre_ping": True,
                    "connect_args": _build_postgres_connect_args(url),
                }
            )
            engine_url = _strip_asyncpg_url_query_params(url)
        else:
            engine_kwargs["poolclass"] = NullPool
            engine_kwargs["connect_args"] = {"timeout": 30}
        
        logger.info(
            "Creating database engine for host=%s port=%s database=%s user=%s",
            url.host,
            url.port or 5432,
            url.database,
            url.username,
        )

        _engine = create_async_engine(engine_url, **engine_kwargs)
        _enable_sqlalchemy_query_logging(_engine)
    return _engine


def _validate_database_url(database_url: str):
    try:
        url = make_url(database_url)
    except Exception as exc:
        raise RuntimeError(
            "Invalid DATABASE_URL format. Use sqlite+aiosqlite:///./retailos.db or postgresql+asyncpg://user:pass@host:port/dbname"
        ) from exc

    if url.drivername in ("sqlite", "sqlite+aiosqlite"):
        if url.drivername == "sqlite":
            url = make_url(database_url.replace("sqlite://", "sqlite+aiosqlite://", 1))
        return url

    if url.drivername == "postgresql":
        url = url.set(drivername="postgresql+asyncpg")

    if url.drivername != "postgresql+asyncpg":
        raise RuntimeError(
            f"Unsupported database driver '{url.drivername}'. Use sqlite+aiosqlite:// or postgresql+asyncpg://"
        )

    if not url.username or not url.password:
        raise RuntimeError("DATABASE_URL must include both username and password.")
    if not url.host:
        raise RuntimeError("DATABASE_URL must include a host.")
    if not url.database:
        raise RuntimeError("DATABASE_URL must include a database name.")

    _resolve_database_host(url.host, url.port or 5432)
    return url


def _build_postgres_connect_args(url):
    connect_args = {
        "timeout": 20,
        "command_timeout": 120,
        "server_settings": {"application_name": "cosmopolitan_backend"},
    }

    sslmode = (
        os.getenv("PGSSLMODE")
        or os.getenv("PGSSL_MODE")
        or url.query.get("sslmode")
        or url.query.get("ssl")
    )
    if sslmode:
        ssl_context = _build_postgres_ssl_context(sslmode)
        if ssl_context is not None:
            connect_args["ssl"] = ssl_context
    elif url.host not in ("localhost", "127.0.0.1", "::1"):
        connect_args["ssl"] = _build_postgres_ssl_context("require")

    return connect_args


def _strip_asyncpg_url_query_params(url):
    """Remove libpq-style URL params that asyncpg does not accept directly."""
    return url.difference_update_query(["sslmode", "ssl"])


def _build_postgres_ssl_context(sslmode: str):
    mode = sslmode.lower()
    if mode in ("disable", "false", "0", "no"):
        return None
    if mode in ("allow", "prefer", "require", "true", "1", "yes"):
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        return context
    if mode == "verify-ca":
        context = ssl.create_default_context()
        context.check_hostname = False
        return context
    if mode == "verify-full":
        return ssl.create_default_context()
    raise RuntimeError(
        "Unsupported PostgreSQL SSL mode. Use disable, require, verify-ca, or verify-full."
    )


def _resolve_database_host(host: str, port: int) -> None:
    try:
        socket.getaddrinfo(host, port, family=socket.AF_UNSPEC, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise RuntimeError(
            f"Failed to resolve DATABASE_URL host '{host}:{port}'. Verify DNS and network connectivity."
        ) from exc


async def _wait_for_connection(engine, attempts: int = 5) -> None:
    last_error = None
    for attempt in range(1, attempts + 1):
        start = time.perf_counter()
        try:
            async with engine.connect() as conn:
                result = await conn.scalar(text("SELECT 1"))
                elapsed = time.perf_counter() - start
                if result != 1:
                    logger.warning("DATABASE_URL connection succeeded but SELECT 1 returned %s", result)
                logger.info(
                    "Database connection verified in %.2fs (attempt %s/%s)",
                    elapsed,
                    attempt,
                    attempts,
                )
                return
        except Exception as exc:
            elapsed = time.perf_counter() - start
            last_error = exc
            logger.warning(
                "Database connection attempt %s/%s failed in %.2fs: %s",
                attempt,
                attempts,
                elapsed,
                exc,
            )
            if attempt == attempts:
                break
            await asyncio.sleep(min(2 ** (attempt - 1), 10))
    raise RuntimeError(
        f"Unable to connect to the database after {attempts} attempts."
    ) from last_error


def _enable_sqlalchemy_query_logging(engine):
    from sqlalchemy import event
    import logging
    import time

    logger = logging.getLogger("cosmopolitan.database")

    @event.listens_for(engine.sync_engine, "before_cursor_execute")
    def before_cursor_execute(conn, cursor, statement, parameters, context, executemany):
        conn.info.setdefault("query_start_time", []).append(time.perf_counter())

    @event.listens_for(engine.sync_engine, "after_cursor_execute")
    def after_cursor_execute(conn, cursor, statement, parameters, context, executemany):
        start_time = conn.info.get("query_start_time")
        if start_time:
            elapsed_ms = (time.perf_counter() - start_time.pop()) * 1000
            logger.debug(
                "SQL executed in %.2f ms: %s | params=%s | rows=%s",
                elapsed_ms,
                statement,
                parameters,
                cursor.rowcount,
            )


def get_async_session():
    """Get SQLAlchemy async session factory"""
    global _async_sessionmaker
    if _async_sessionmaker is None:
        _async_sessionmaker = sessionmaker(
            get_engine(), class_=AsyncSession, expire_on_commit=False
        )
    return _async_sessionmaker

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
    # Batch tracking (Phase 3): transfer lines remember which source batch the
    # operator picked and which lots got drained on approve.
    ("transfer_line_items", "preferred_batch_id",   "VARCHAR"),
    ("transfer_line_items", "requested_allocation", "TEXT"),
    ("transfer_line_items", "batch_allocation",     "TEXT"),
    ("organisations", "tax_pricing_mode", "VARCHAR DEFAULT 'inclusive'"),
    ("invoice_template_settings", "show_attr", "BOOLEAN DEFAULT 1"),
    ("invoice_template_settings", "show_size", "BOOLEAN DEFAULT 1"),
    ("invoice_template_settings", "show_disc", "BOOLEAN DEFAULT 1"),
    ("invoice_template_settings", "tax_mode", "VARCHAR DEFAULT 'total'"),
    ("invoice_template_settings", "show_customer", "BOOLEAN DEFAULT 1"),
    ("invoice_template_settings", "show_payment", "BOOLEAN DEFAULT 1"),
    ("invoice_template_settings", "show_printed_date", "BOOLEAN DEFAULT 1"),
    ("invoice_template_settings", "show_store", "BOOLEAN DEFAULT 1"),
    ("invoice_template_settings", "show_cashier", "BOOLEAN DEFAULT 1"),
    ("invoice_template_settings", "footer_msg", "TEXT DEFAULT ''"),
    ("invoice_template_settings", "footer_note", "TEXT DEFAULT ''"),
    ("item_branch_config", "cost_price", "FLOAT"),
    ("stock_adjustments", "request_id", "VARCHAR"),
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
    import src.models  # noqa: F401 — register all ORM tables on Base.metadata

    engine = get_engine()
    await _wait_for_connection(engine)
    start = time.perf_counter()
    logger.info("Starting schema initialization")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await _ensure_columns(conn)
        await _ensure_nullable_columns(conn)
        await _bootstrap_system_roles(conn)
        await _bootstrap_document_numbering(conn)
        await _bootstrap_default_tax_rates(conn)
        await _bootstrap_invoice_template(conn)
        await _backfill_role_ids(conn)
        await _backfill_item_branch_config(conn)
        await _migrate_adjustment_requests_per_branch_ref(conn)
    logger.info("Schema initialization completed in %.2f seconds", time.perf_counter() - start)


async def _bootstrap_system_roles(conn) -> None:
    """Idempotently insert the 6 system roles (D6). Lets demo databases that
    weren't re-seeded after this PR still pick up the new RBAC tables.
    A re-seed via seed.py drops everything first, so there's no conflict."""
    # Local import avoids a top-level cycle (system_roles is a leaf module).
    import json

    from src.system_roles import SYSTEM_ROLES

    rows = (await conn.execute(text("SELECT id, permissions FROM roles"))).fetchall()
    existing = {r[0]: r[1] for r in rows}
    for rid, key, label, color, description, perms in SYSTEM_ROLES:
        if rid in existing:
            current = existing[rid] or []
            if isinstance(current, str):
                try:
                    current = json.loads(current)
                except json.JSONDecodeError:
                    current = []
            merged = list(dict.fromkeys([*(current or []), *perms]))
            if merged != (current or []):
                await conn.execute(
                    text("UPDATE roles SET permissions = :perms WHERE id = :id AND is_system = :is_system"),
                    {"id": rid, "perms": json.dumps(merged), "is_system": True},
                )
            continue
        await conn.execute(
            text(
                "INSERT INTO roles (id, key, label, description, color, permissions, is_system, active) "
                "VALUES (:id, :key, :label, :desc, :color, :perms, :is_system, :active)"
            ),
            {
                "id": rid,
                "key": key,
                "label": label,
                "desc": description,
                "color": color,
                "perms": json.dumps(perms),
                "is_system": True,
                "active": True,
            },
        )


async def _ensure_columns(conn) -> None:
    """For SQLite, add any missing columns from `_ADDITIVE_COLUMNS`. No-op on
    columns that already exist."""
    for table, column, ddl_type in _ADDITIVE_COLUMNS:
        if conn.dialect.name == "sqlite":
            rows = (
                await conn.execute(
                    text(f"PRAGMA table_info('{table}')")
                )
            ).fetchall()
            existing = {r[1] for r in rows}
        else:
            rows = (
                await conn.execute(
                    text(f"""
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_name = '{table}'
                    """)
                )
            ).fetchall()
            existing = {r[0] for r in rows}

        if column in existing:
            continue
        await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl_type}"))


async def _ensure_nullable_columns(conn) -> None:
    """Ensure columns that should be nullable are nullable in existing DBs."""
    if conn.dialect.name == "postgresql":
        nullable = (
            await conn.execute(
                text(
                    "SELECT is_nullable FROM information_schema.columns "
                    "WHERE table_name = 'items' AND column_name = 'category_id'"
                )
            )
        ).scalar_one_or_none()
        if nullable == "NO":
            await conn.execute(text("ALTER TABLE items ALTER COLUMN category_id DROP NOT NULL"))


async def _bootstrap_document_numbering(conn) -> None:
    """Idempotently seed document numbering templates for existing databases."""
    from src.document_numbering import DEFAULT_NUMBERING

    rows = (await conn.execute(text("SELECT doc_type FROM document_numbering"))).fetchall()
    existing = {r[0] for r in rows}
    for cfg in DEFAULT_NUMBERING:
        if cfg["doc_type"] in existing:
            if cfg["doc_type"] == "stock_adjustment":
                await conn.execute(
                    text(
                        "UPDATE document_numbering SET scope = 'per_branch' "
                        "WHERE doc_type = 'stock_adjustment' AND scope != 'per_branch'"
                    )
                )
            continue
        await conn.execute(
            text(
                "INSERT INTO document_numbering "
                "(doc_type, label, prefix, format, scope, next_seq) "
                "VALUES (:doc_type, :label, :prefix, :format, :scope, :next_seq)"
            ),
            cfg,
        )


async def _bootstrap_default_tax_rates(conn) -> None:
    """Idempotently insert 0% and 8% default tax rates."""
    from src.tax_defaults import DEFAULT_TAX_RATES

    rows = (await conn.execute(text("SELECT id FROM tax_rates"))).fetchall()
    existing = {r[0] for r in rows}
    for tid, rate, label, examples, is_system in DEFAULT_TAX_RATES:
        if tid in existing:
            continue
        await conn.execute(
            text(
                "INSERT INTO tax_rates (id, rate, label, examples, active, is_system) "
                "VALUES (:id, :rate, :label, :examples, :active, :is_system)"
            ),
            {
                "id": tid,
                "rate": rate,
                "label": label,
                "examples": examples,
                "active": True,
                "is_system": bool(is_system),
            },
        )


async def _bootstrap_invoice_template(conn) -> None:
    """Idempotently seed default invoice template settings."""
    from src.invoice_template_defaults import DEFAULT_INVOICE_TEMPLATE

    row = (await conn.execute(text("SELECT id FROM invoice_template_settings LIMIT 1"))).fetchone()
    if row:
        await _migrate_invoice_template_columns(conn)
        return
    cfg = DEFAULT_INVOICE_TEMPLATE
    await conn.execute(
        text(
            "INSERT INTO invoice_template_settings "
            "(id, header_style, show_attr, show_size, show_disc, show_hsn, tax_mode, "
            "show_customer, show_payment, show_printed_date, show_store, show_cashier, "
            "footer_msg, footer_note) "
            "VALUES (:id, :header_style, :show_attr, :show_size, :show_disc, :show_hsn, :tax_mode, "
            ":show_customer, :show_payment, :show_printed_date, :show_store, :show_cashier, "
            ":footer_msg, :footer_note)"
        ),
        {
            "id": cfg["id"],
            "header_style": cfg["header_style"],
            "show_attr": 1 if cfg["show_attr"] else 0,
            "show_size": 1 if cfg["show_size"] else 0,
            "show_disc": 1 if cfg["show_disc"] else 0,
            "show_hsn": 1 if cfg["show_hsn"] else 0,
            "tax_mode": cfg["tax_mode"],
            "show_customer": 1 if cfg["show_customer"] else 0,
            "show_payment": 1 if cfg["show_payment"] else 0,
            "show_printed_date": 1 if cfg["show_printed_date"] else 0,
            "show_store": 1 if cfg["show_store"] else 0,
            "show_cashier": 1 if cfg["show_cashier"] else 0,
            "footer_msg": cfg["footer_msg"],
            "footer_note": cfg["footer_note"],
        },
    )


async def _migrate_invoice_template_columns(conn) -> None:
    """Backfill new columns from legacy invoice_template_settings fields."""
    await conn.execute(
        text(
            "UPDATE invoice_template_settings SET header_style = CASE header_style "
            "WHEN 'name_and_logo' THEN 'full' WHEN 'logo_only' THEN 'logo' "
            "WHEN 'name_only' THEN 'nameonly' ELSE header_style END "
            "WHERE header_style IN ('name_and_logo', 'logo_only', 'name_only')"
        )
    )
    await conn.execute(
        text(
            "UPDATE invoice_template_settings SET tax_mode = CASE tax_display "
            "WHEN 'total_only' THEN 'total' WHEN 'cgst_sgst' THEN 'itemized' "
            "WHEN 'igst' THEN 'itemized' ELSE COALESCE(NULLIF(tax_mode, ''), 'total') END "
            "WHERE (tax_mode IS NULL OR tax_mode = '') "
            "AND tax_display IS NOT NULL AND tax_display != ''"
        )
    )
    await conn.execute(
        text(
            "UPDATE invoice_template_settings SET footer_msg = footer_text "
            "WHERE (footer_msg IS NULL OR footer_msg = '') "
            "AND footer_text IS NOT NULL AND footer_text != ''"
        )
    )
    await conn.execute(
        text(
            "UPDATE invoice_template_settings SET footer_note = terms_text "
            "WHERE (footer_note IS NULL OR footer_note = '') "
            "AND terms_text IS NOT NULL AND terms_text != ''"
        )
    )
    await conn.execute(
        text(
            "UPDATE invoice_template_settings SET show_attr = show_item_description "
            "WHERE show_attr IS NULL AND show_item_description IS NOT NULL"
        )
    )


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


async def _existing_tables(conn, names: list[str]) -> set[str]:
    """Return which of *names* exist — works on SQLite (dev) and PostgreSQL."""
    if not names:
        return set()
    if conn.dialect.name == "sqlite":
        in_list = ", ".join(f"'{n}'" for n in names)
        rows = (
            await conn.execute(
                text(
                    f"SELECT name FROM sqlite_master "
                    f"WHERE type='table' AND name IN ({in_list})"
                )
            )
        ).fetchall()
        return {r[0] for r in rows}
    in_list = ", ".join(f"'{n}'" for n in names)
    rows = (
        await conn.execute(
            text(
                f"SELECT table_name FROM information_schema.tables "
                f"WHERE table_schema = 'public' AND table_name IN ({in_list})"
            )
        )
    ).fetchall()
    return {r[0] for r in rows}


async def _backfill_item_branch_config(conn) -> None:
    """Seed ``item_branch_config`` for databases created before multi-branch
    item master. Preserves legacy behaviour: every active item is listed at
    every active branch with default pricing until an admin changes it."""
    import uuid

    table_names = await _existing_tables(
        conn, ["items", "branches", "item_branch_config"]
    )
    if "item_branch_config" not in table_names:
        return
    if "items" not in table_names or "branches" not in table_names:
        return

    item_count = (await conn.execute(text("SELECT COUNT(*) FROM items"))).scalar() or 0
    if item_count == 0:
        return

    existing = int(
        (await conn.execute(text("SELECT COUNT(*) FROM item_branch_config"))).scalar() or 0
    )
    if existing > 0:
        return

    rows = (
        await conn.execute(
            text(
                "SELECT i.id, b.id FROM items i "
                "CROSS JOIN branches b "
                "WHERE i.active IS TRUE AND b.active IS TRUE"
            )
        )
    ).fetchall()
    for item_id, branch_id in rows:
        await conn.execute(
            text(
                "INSERT INTO item_branch_config "
                "(id, item_id, branch_id, is_available, selling_price, reorder_level) "
                "VALUES (:id, :item_id, :branch_id, true, NULL, NULL)"
            ),
            {"id": str(uuid.uuid4()), "item_id": item_id, "branch_id": branch_id},
        )


async def _migrate_adjustment_requests_per_branch_ref(conn) -> None:
    """Replace global UNIQUE(ref_number) with UNIQUE(branch_id, ref_number).

    Per-branch document numbering can reuse the same ADJ-YYYY-#### at different
    branches; only the pair (branch_id, ref_number) must be unique.
    """
    table_names = await _existing_tables(conn, ["adjustment_requests"])
    if "adjustment_requests" not in table_names:
        return

    if conn.dialect.name == "sqlite":
        ddl = (
            await conn.execute(
                text(
                    "SELECT sql FROM sqlite_master "
                    "WHERE type='table' AND name='adjustment_requests'"
                )
            )
        ).scalar()
        if not ddl or "uq_adj_branch_ref" in ddl:
            return

        await conn.execute(
            text(
                """
                CREATE TABLE adjustment_requests_mig (
                    id VARCHAR NOT NULL PRIMARY KEY,
                    ref_number VARCHAR NOT NULL,
                    branch_id VARCHAR NOT NULL,
                    branch_name VARCHAR,
                    item_id VARCHAR NOT NULL,
                    item_name VARCHAR,
                    before_qty INTEGER DEFAULT 0,
                    new_qty INTEGER NOT NULL,
                    reason VARCHAR,
                    notes TEXT,
                    batch_id VARCHAR,
                    status VARCHAR,
                    requested_by VARCHAR,
                    approved_by VARCHAR,
                    rejected_by VARCHAR,
                    rejection_notes TEXT,
                    created_at DATETIME,
                    resolved_at DATETIME,
                    FOREIGN KEY(branch_id) REFERENCES branches(id),
                    FOREIGN KEY(item_id) REFERENCES items(id),
                    UNIQUE (branch_id, ref_number)
                )
                """
            )
        )
        await conn.execute(
            text(
                """
                INSERT INTO adjustment_requests_mig
                SELECT id, ref_number, branch_id, branch_name, item_id, item_name,
                       before_qty, new_qty, reason, notes, batch_id, status,
                       requested_by, approved_by, rejected_by, rejection_notes,
                       created_at, resolved_at
                FROM adjustment_requests
                """
            )
        )
        await conn.execute(text("DROP TABLE adjustment_requests"))
        await conn.execute(
            text("ALTER TABLE adjustment_requests_mig RENAME TO adjustment_requests")
        )
        return

    has_composite = (
        await conn.execute(
            text(
                "SELECT 1 FROM pg_constraint c "
                "JOIN pg_class t ON c.conrelid = t.oid "
                "WHERE t.relname = 'adjustment_requests' "
                "AND c.conname = 'uq_adj_branch_ref'"
            )
        )
    ).scalar()
    if has_composite:
        return

    await conn.execute(
        text(
            "ALTER TABLE adjustment_requests "
            "DROP CONSTRAINT IF EXISTS adjustment_requests_ref_number_key"
        )
    )
    await conn.execute(
        text(
            "ALTER TABLE adjustment_requests "
            "ADD CONSTRAINT uq_adj_branch_ref "
            "UNIQUE (branch_id, ref_number)"
        )
    )
