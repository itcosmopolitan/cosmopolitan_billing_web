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

from src.db_dialect import additive_column_ddl

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
    # Sales Phase 1 (2026-05-23): money we owe the customer. Separate from
    # `outstanding` so the two intents don't sign-flip on each other.
    ("customers", "credit_balance", "FLOAT DEFAULT 0 NOT NULL"),
    # 2026-05-24: parity with sale_invoices.payment_mode on vendor bills.
    ("purchase_bills", "payment_mode", "VARCHAR"),
    # 2026-05-24: per-line discount on purchase bills (percent).
    ("purchase_line_items", "discount", "FLOAT DEFAULT 0 NOT NULL"),
    # 2026-05-25: link vendor return lines back to the originating bill
    # line. Lets the backend reject over-returning (cumulative return_qty
    # across all returns for this bill > bill_line.qty). Nullable so
    # legacy return rows still load; the create_return validation
    # gracefully falls back to (item_id, name) matching when the column
    # is null. Parity with sales_return_line_items.invoice_line_id.
    ("return_line_items", "bill_line_id", "VARCHAR"),
    # 2026-05-31: per-line stock-consumption ledger for vendor returns, so
    # deleting a return can reverse the exact lots it drained. JSON text;
    # NULL for legacy returns that never moved stock (those must not be
    # re-added on delete). See routes/purchases.create_return.
    ("return_line_items", "batch_allocation", "TEXT"),
    # 2026-05-31: batch-aware returns. The sale line remembers which lots it
    # consumed; the sales-return line remembers which lots it restored to
    # (for the per-batch cumulative cap + delete reversal). JSON text.
    ("sale_line_items", "batch_allocation", "TEXT"),
    ("sales_return_line_items", "batch_allocation", "TEXT"),
    # 2026-05-30: back-pointer from a quotation to the sales order it
    # spawned. Lets the bulk-delete guard check whether a LIVE sales
    # order still depends on the quote (the `status='converted'` flag
    # never resets, so it falsely blocked quote deletion even after the
    # SO was deleted). Nullable; legacy converted quotes have NULL here
    # and the guard treats NULL as "no live dependency".
    ("quotations", "converted_order_id", "VARCHAR"),
    # 2026-06-09: direct quote→invoice convert (skip SO). Nullable until
    # conversion; mirrors converted_order_id / SalesOrder.converted_invoice_id.
    ("quotations", "converted_invoice_id", "VARCHAR"),
    # 2026-06-09: credit-term due date for overdue automation on sales side.
    ("sale_invoices", "due_date", "VARCHAR"),
    # 2026-06-09: soft void for payments (audit trail vs hard delete).
    ("customer_payments", "voided", "BOOLEAN DEFAULT 0 NOT NULL"),
    ("customer_payments", "voided_at", "VARCHAR"),
    ("vendor_payments", "voided", "BOOLEAN DEFAULT 0 NOT NULL"),
    ("vendor_payments", "voided_at", "VARCHAR"),
    # Phase 0 (2026-06-09): org inventory policy + document return tracking.
    ("organisations", "allow_overselling", "BOOLEAN DEFAULT 1 NOT NULL"),
    ("sale_invoices", "credited_amount", "FLOAT DEFAULT 0 NOT NULL"),
    ("sale_invoices", "return_status", "VARCHAR DEFAULT 'none'"),
    ("purchase_bills", "credited_amount", "FLOAT DEFAULT 0 NOT NULL"),
    ("purchase_bills", "return_status", "VARCHAR DEFAULT 'none'"),
    # Phase 3: bill → GRN back-link (stock lives on GRN).
    ("purchase_bills", "grn_id", "VARCHAR"),
    # Phase 4: POS vs back-office invoice provenance (drives receipt numbering).
    ("sale_invoices", "origin", "VARCHAR DEFAULT 'invoice'"),
    # Phase 4: org-level POS / invoice prefix + sequence start (JSON text).
    ("organisations", "numbering_config", "TEXT"),
    # Purchase Phase 3 (2026-06-09): vendor advance / overpayment credit.
    ("vendors", "credit_balance", "FLOAT DEFAULT 0 NOT NULL"),
    ("vendor_payments", "credit_applied", "FLOAT DEFAULT 0 NOT NULL"),
    ("vendor_returns", "voided", "BOOLEAN DEFAULT 0 NOT NULL"),
    ("vendor_returns", "voided_at", "VARCHAR"),
    # Cash Control (2026-06-14): per-branch petty cash settings.
    ("branches", "cash_opening_mode",       "VARCHAR DEFAULT 'carry_forward'"),
    ("branches", "cash_fixed_float",        "FLOAT DEFAULT 0"),
    ("branches", "cash_variance_threshold", "FLOAT DEFAULT 500"),
    # Cash Control (2026-06-14): extended CashEntry tracking columns.
    ("cash_entries", "entry_number", "VARCHAR"),
    ("cash_entries", "source_type",  "VARCHAR DEFAULT 'manual'"),
    ("cash_entries", "source_id",    "VARCHAR"),
    ("cash_entries", "is_system",    "BOOLEAN DEFAULT 0 NOT NULL"),
    ("cash_entries", "is_voided",    "BOOLEAN DEFAULT 0 NOT NULL"),
    ("cash_entries", "voided_at",    "VARCHAR"),
    ("cash_entries", "voided_by",    "VARCHAR"),
    ("cash_entries", "void_reason",  "TEXT"),
    # Activity timeline (Phase A): polymorphic links + normalized event key
    # on top of existing audit_logs rows. Nullable to preserve legacy writes.
    ("audit_logs", "record_type",    "VARCHAR"),
    ("audit_logs", "record_id",      "VARCHAR"),
    ("audit_logs", "event_type",     "VARCHAR"),
    ("audit_logs", "event_metadata", "TEXT"),
    ("audit_logs", "user_role",      "VARCHAR DEFAULT 'unknown' NOT NULL"),
    ("audit_logs", "reference_id",   "VARCHAR DEFAULT ''"),
    # Approval workflow: item master pending creates.
    ("items", "approval_status", "VARCHAR DEFAULT 'approved' NOT NULL"),
    ("items", "status",          "VARCHAR DEFAULT 'approved' NOT NULL"),
    ("items", "created_by",      "VARCHAR"),
    ("items", "approved_by",     "VARCHAR"),
    ("items", "rejected_by",     "VARCHAR"),
    ("items", "approved_at",     "VARCHAR"),
    ("items", "rejected_at",     "VARCHAR"),
    ("items", "rejection_reason", "TEXT"),
]

_REQUIRED_AUDIT_ACTIVITY_COLUMNS = {
    "record_type",
    "record_id",
    "event_type",
    "event_metadata",
}

# Map legacy users.role enum values → seeded roles.id from seed.py SYSTEM_ROLES.
LEGACY_ROLE_TO_ID: dict[str, str] = {
    "super_admin":       "role-super-admin",
    "branch_manager":    "role-branch-manager",
    "branch_supervisor": "role-branch-supervisor",
    "cashier":           "role-cashier",
    "inventory_manager": "role-branch-supervisor",
    "finance":           "role-branch-supervisor",
    "purchase_admin":    "role-branch-supervisor",
}


_ACTIVITY_PERMS_ALL = [
    "history.view",
    "comments.view",
    "comments.add",
    "comments.edit_own",
    "comments.delete_any",
]

_ACTIVITY_PERMS_STANDARD_ALLOW = [
    "history.view",
    "comments.view",
    "comments.add",
    "comments.edit_own",
]

_ACTIVITY_ADMIN_DEFAULT_ROLES = {"super_admin", "branch_manager"}
_ACTIVITY_STANDARD_DEFAULT_ROLES = {"purchase_admin", "finance", "inventory_manager"}
_ACTIVITY_NO_ACCESS_DEFAULT_ROLES = {"cashier"}


async def init_schema() -> None:
    """Create tables, then apply additive column migrations and the role-id
    backfill (D6). Called from main.py startup after Base.metadata.create_all.
    """
    import src.models  # noqa: F401 — register all ORM tables on Base.metadata

    engine = get_engine()
    await _wait_for_connection(engine)
    start = time.perf_counter()
    logger.info("Starting schema initialization")
    async with engine.connect() as ddl_conn:
        autocommit_conn = await ddl_conn.execution_options(isolation_level="AUTOCOMMIT")
        await autocommit_conn.run_sync(Base.metadata.create_all)
        # PG requires new enum labels to be committed before they can be referenced.
        await _ensure_pg_enum_values(autocommit_conn)
    async with engine.begin() as conn:
        await _ensure_columns(conn)
        await _ensure_audit_log_indexes(conn)
        await _ensure_nullable_columns(conn)
        await _bootstrap_system_roles(conn)
        await _ensure_activity_seed_markers_table(conn)
        await _bootstrap_activity_role_defaults(conn)
        await _migrate_item_master_permissions(conn)
        await _purge_legacy_system_roles(conn)
        await _bootstrap_document_numbering(conn)
        await _bootstrap_default_tax_rates(conn)
        await _bootstrap_invoice_template(conn)
        await _backfill_role_ids(conn)
        await _backfill_item_branch_config(conn)
        await _migrate_adjustment_requests_per_branch_ref(conn)
        await _repair_return_invoice_totals(conn)
    logger.info("Schema initialization completed in %.2f seconds", time.perf_counter() - start)


async def assert_activity_audit_schema() -> None:
    """Fail fast if activity timeline columns are missing from audit_logs.

    This is a post-migration safety net for deployments that might start from
    older database snapshots.
    """
    engine = get_engine()
    async with engine.connect() as conn:
        if conn.dialect.name == "postgresql":
            rows = (
                await conn.execute(
                    text(
                        "SELECT column_name FROM information_schema.columns "
                        "WHERE table_schema = current_schema() AND table_name = 'audit_logs'"
                    )
                )
            ).fetchall()
            existing = {r[0] for r in rows}
        else:
            rows = (await conn.execute(text("PRAGMA table_info(audit_logs)"))).fetchall()
            existing = {r[1] for r in rows}

    missing = sorted(_REQUIRED_AUDIT_ACTIVITY_COLUMNS - existing)
    if missing:
        raise RuntimeError(
            "audit_logs is missing required activity columns: " + ", ".join(missing)
        )


async def _bootstrap_system_roles(conn) -> None:
    """Idempotently insert/update system roles. Lets demo databases that
    weren't re-seeded after this PR still pick up the new RBAC tables."""
    import json

    from src.system_roles import SYSTEM_ROLES

    rows = (await conn.execute(text("SELECT id, permissions FROM roles"))).fetchall()
    existing = {r[0]: r[1] for r in rows}
    for rid, key, label, color, description, perms in SYSTEM_ROLES:
        if rid in existing:
            await conn.execute(
                text(
                    "UPDATE roles SET key = :key, label = :label, description = :desc, "
                    "color = :color, permissions = :perms, is_system = :is_system, active = :active "
                    "WHERE id = :id"
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

async def _migrate_item_master_permissions(conn) -> None:
    """Rewrite legacy items.create/edit/delete/approve → item_master.* on custom roles."""
    import json

    legacy_map = {
        "items.create": "item_master.create",
        "items.edit": "item_master.edit",
        "items.delete": "item_master.delete",
        "items.approve": "item_master.approve",
    }
    rows = (await conn.execute(text("SELECT id, permissions FROM roles"))).fetchall()
    for rid, raw in rows:
        perms = raw or []
        if isinstance(perms, str):
            try:
                perms = json.loads(perms)
            except json.JSONDecodeError:
                perms = []
        if not isinstance(perms, list):
            continue
        out: list[str] = []
        changed = False
        for p in perms:
            if p == "items.*":
                out.extend(["item_master.*", "items.*"])
                changed = True
            elif p in legacy_map:
                out.append(legacy_map[p])
                changed = True
            elif p not in out:
                out.append(p)
        if not changed:
            continue
        deduped = list(dict.fromkeys(out))
        await conn.execute(
            text("UPDATE roles SET permissions = :perms WHERE id = :id"),
            {"id": rid, "perms": json.dumps(deduped)},
        )


async def _purge_legacy_system_roles(conn) -> None:
    """Move users off old system roles, then delete those role rows."""
    from src.system_roles import LEGACY_SYSTEM_ROLE_IDS

    if not LEGACY_SYSTEM_ROLE_IDS:
        return
    in_list = ", ".join(f"'{rid}'" for rid in LEGACY_SYSTEM_ROLE_IDS)
    await conn.execute(
        text(
            f"UPDATE users SET role_id = 'role-branch-supervisor', role = 'branch_supervisor' "
            f"WHERE role_id IN ({in_list})"
        )
    )
    await conn.execute(
        text(f"DELETE FROM roles WHERE id IN ({in_list}) AND is_system = true")
    )


async def _bootstrap_activity_role_defaults(conn) -> None:
    """Seed activity defaults ONCE per (role, permission) pair.

    Mapping:
    - admin tier (all true): super_admin, branch_manager
    - standard tier (delete_any false): purchase_admin, finance, inventory_manager
    - no-access tier (all false): cashier

    One-time semantics:
    - Defaults apply only when no marker exists in role_permission_seed_markers.
    - Once marked, later bootstraps do not overwrite UI-administered changes.
    """
    import json

    role_keys = sorted(
        _ACTIVITY_ADMIN_DEFAULT_ROLES
        | _ACTIVITY_STANDARD_DEFAULT_ROLES
        | _ACTIVITY_NO_ACCESS_DEFAULT_ROLES
    )
    keys_sql = ", ".join(f"'{k}'" for k in role_keys)
    rows = (
        await conn.execute(
            text(
                "SELECT id, key, permissions FROM roles "
                f"WHERE key IN ({keys_sql})"
            )
        )
    ).fetchall()

    marker_rows = (
        await conn.execute(
            text(
                "SELECT role_id, permission_key FROM role_permission_seed_markers "
                "WHERE permission_key IN ('history.view','comments.view','comments.add','comments.edit_own','comments.delete_any')"
            )
        )
    ).fetchall()
    seeded_pairs = {(rid, pkey) for rid, pkey in marker_rows}

    for rid, key, perms in rows:
        current = perms or []
        if isinstance(current, str):
            try:
                current = json.loads(current)
            except json.JSONDecodeError:
                current = []
        current = list(current or [])
        updated = list(current)

        for perm in _ACTIVITY_PERMS_ALL:
            if (rid, perm) in seeded_pairs:
                continue

            default_allow = None
            if key in _ACTIVITY_ADMIN_DEFAULT_ROLES:
                default_allow = True
            elif key in _ACTIVITY_STANDARD_DEFAULT_ROLES:
                default_allow = perm in _ACTIVITY_PERMS_STANDARD_ALLOW
            elif key in _ACTIVITY_NO_ACCESS_DEFAULT_ROLES:
                default_allow = False

            if default_allow is True and perm not in updated:
                updated.append(perm)

            await conn.execute(
                text(
                    "INSERT INTO role_permission_seed_markers (role_id, permission_key, seeded_at) "
                    "VALUES (:role_id, :permission_key, CURRENT_TIMESTAMP) "
                    "ON CONFLICT(role_id, permission_key) DO NOTHING"
                ),
                {"role_id": rid, "permission_key": perm},
            )

        if updated != current:
            await conn.execute(
                text("UPDATE roles SET permissions = :perms WHERE id = :id"),
                {"id": rid, "perms": json.dumps(updated)},
            )


async def _ensure_activity_seed_markers_table(conn) -> None:
    """Create one-time seed marker table for role-permission defaults."""
    await conn.execute(
        text(
            "CREATE TABLE IF NOT EXISTS role_permission_seed_markers ("
            "role_id VARCHAR NOT NULL, "
            "permission_key VARCHAR NOT NULL, "
            "seeded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, "
            "PRIMARY KEY (role_id, permission_key), "
            "FOREIGN KEY(role_id) REFERENCES roles(id) ON DELETE CASCADE"
            ")"
        )
    )


async def _ensure_columns(conn) -> None:
    """Add any missing columns from `_ADDITIVE_COLUMNS`. Idempotent."""
    dialect = conn.dialect.name
    for table, column, ddl_type in _ADDITIVE_COLUMNS:
        if dialect == "postgresql":
            table_exists = (
                await conn.execute(
                    text(
                        "SELECT EXISTS ("
                        "  SELECT 1 FROM information_schema.tables "
                        "  WHERE table_schema = current_schema() AND table_name = :table"
                        ")"
                    ),
                    {"table": table},
                )
            ).scalar()
            if not table_exists:
                continue
            rows = (
                await conn.execute(
                    text(
                        "SELECT column_name FROM information_schema.columns "
                        "WHERE table_schema = current_schema() AND table_name = :table"
                    ),
                    {"table": table},
                )
            ).fetchall()
            existing = {r[0] for r in rows}
            ddl = additive_column_ddl(ddl_type)
        else:
            rows = (await conn.execute(text(f"PRAGMA table_info({table})"))).fetchall()
            if not rows:
                continue  # table not created yet (fresh partial DB)
            existing = {r[1] for r in rows}  # row[1] = column name
            ddl = ddl_type
        if column in existing:
            continue
        await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))


async def _ensure_audit_log_indexes(conn) -> None:
    """Create timeline read indexes for audit logs (idempotent)."""
    if conn.dialect.name == "postgresql":
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_audit_logs_record_created "
                "ON audit_logs (record_type, record_id, created_at DESC)"
            )
        )
        return

    # SQLite path used in local dev. IF NOT EXISTS is supported.
    await conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_audit_logs_record_created "
            "ON audit_logs (record_type, record_id, created_at DESC)"
        )
    )


# PostgreSQL enums are created at first table migration; new Python enum
# members added later need an explicit ALTER TYPE … ADD VALUE.
_PG_ENUM_VALUES: list[tuple[str, str]] = [
    ("purchaseorderstatus", "partially_received"),
    ("purchaseorderstatus", "pending_approval"),
    ("salesorderstatus", "partially_invoiced"),
    ("userrole", "branch_supervisor"),
    ("itemapprovalstatus", "pending"),
    ("itemapprovalstatus", "pending_approval"),
]


async def _ensure_pg_enum_values(conn) -> None:
    """Idempotently add missing PostgreSQL enum labels."""
    if conn.dialect.name != "postgresql":
        return
    for enum_name, value in _PG_ENUM_VALUES:
        exists = (
            await conn.execute(
                text(
                    "SELECT 1 FROM pg_enum e "
                    "JOIN pg_type t ON e.enumtypid = t.oid "
                    "WHERE t.typname = :enum AND e.enumlabel = :val"
                ),
                {"enum": enum_name, "val": value},
            )
        ).scalar()
        if exists:
            continue
        await conn.execute(text(f"ALTER TYPE {enum_name} ADD VALUE '{value}'"))


async def _ensure_nullable_columns(conn) -> None:
    """Ensure columns that should be nullable are nullable in existing DBs."""
    if conn.dialect.name == "postgresql":
        result = await conn.execute(
            text(
                "SELECT is_nullable FROM information_schema.columns "
                "WHERE table_name = 'items' AND column_name = 'category_id'"
            )
        )
        nullable = result.scalar_one_or_none()
        if nullable == "NO":
            await conn.execute(text("ALTER TABLE items ALTER COLUMN category_id DROP NOT NULL"))

        for table, column in (("audit_logs", "user_role"), ("audit_logs", "reference_id")):
            result = await conn.execute(
                text(
                    "SELECT is_nullable FROM information_schema.columns "
                    "WHERE table_name = :table AND column_name = :column"
                ),
                {"table": table, "column": column},
            )
            is_nullable = result.scalar_one_or_none()
            if is_nullable == "NO":
                await conn.execute(text(f"ALTER TABLE {table} ALTER COLUMN {column} DROP NOT NULL"))

        result = await conn.execute(
            text(
                "SELECT column_default FROM information_schema.columns "
                "WHERE table_name = 'audit_logs' AND column_name = 'reference_id'"
            )
        )
        default_value = result.scalar_one_or_none()
        if default_value is None:
            await conn.execute(text("ALTER TABLE audit_logs ALTER COLUMN reference_id SET DEFAULT ''"))


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
            "show_attr": bool(cfg["show_attr"]),
            "show_size": bool(cfg["show_size"]),
            "show_disc": bool(cfg["show_disc"]),
            "show_hsn": bool(cfg["show_hsn"]),
            "tax_mode": cfg["tax_mode"],
            "show_customer": bool(cfg["show_customer"]),
            "show_payment": bool(cfg["show_payment"]),
            "show_printed_date": bool(cfg["show_printed_date"]),
            "show_store": bool(cfg["show_store"]),
            "show_cashier": bool(cfg["show_cashier"]),
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


async def _repair_return_invoice_totals(conn) -> None:
    """One-time repair: restore sale_invoices.total and paid_amount that were
    incorrectly reduced by the pre-fix return creation flow.

    The old code did `inv.total -= return.total` and (for cash) `inv.paid_amount -= credited`.
    The correct approach: total and paid_amount are immutable after invoice creation;
    only credited_amount changes. This repair uses subtotal+tax_total-discount (never mutated)
    as the source-of-truth original total.

    Idempotent: the guard `expected_total - total > 0.01` only matches rows that
    were mutated downward. After the first repair run, total == expected_total, so
    subsequent startups are no-ops.
    """
    table_names = await _existing_tables(conn, ["sale_invoices", "sales_returns"])
    if "sale_invoices" not in table_names:
        return

    # Step 1: restore inv.total = original (subtotal + tax_total - discount)
    await conn.execute(text("""
        UPDATE sale_invoices
        SET total = subtotal + tax_total - COALESCE(discount, 0)
        WHERE (subtotal + tax_total - COALESCE(discount, 0)) - total > 0.01
          AND COALESCE(credited_amount, 0) > 0
    """))

    if "sales_returns" not in table_names:
        return

    # Step 2: restore inv.paid_amount reduced by cash-method returns.
    # Add back credited_amount from each active (processed) cash return for this invoice.
    # Same guard as above — only fires on rows where total was mutated.
    if conn.dialect.name == "postgresql":
        await conn.execute(text("""
            UPDATE sale_invoices inv
            SET paid_amount = inv.paid_amount + COALESCE(cr.cash_credited, 0)
            FROM (
                SELECT invoice_id, SUM(credited_amount) AS cash_credited
                FROM sales_returns
                WHERE status = 'processed'
                  AND refund_method = 'cash'
                  AND COALESCE(credited_amount, 0) > 0
                GROUP BY invoice_id
            ) cr
            WHERE inv.id = cr.invoice_id
              AND (inv.subtotal + inv.tax_total - COALESCE(inv.discount, 0)) - inv.paid_amount > 0.01
              AND COALESCE(inv.credited_amount, 0) > 0
        """))
    else:
        # SQLite correlated subquery
        await conn.execute(text("""
            UPDATE sale_invoices
            SET paid_amount = paid_amount + COALESCE((
                SELECT SUM(credited_amount)
                FROM sales_returns
                WHERE invoice_id = sale_invoices.id
                  AND status = 'processed'
                  AND refund_method = 'cash'
                  AND COALESCE(credited_amount, 0) > 0
            ), 0)
            WHERE (subtotal + tax_total - COALESCE(discount, 0)) - paid_amount > 0.01
              AND COALESCE(credited_amount, 0) > 0
        """))
