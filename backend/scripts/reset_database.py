"""Destructively reset the configured PostgreSQL database and rebuild its schema."""

from __future__ import annotations

import argparse
import asyncio
import os
import subprocess
import sys
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.engine import make_url

ROOT = Path(__file__).resolve().parents[1]

INITIAL_ORGANISATION_NAME = "Cosmopolitan Campa Brothers"
INITIAL_USER_NAME = "Hari Sudhan"
INITIAL_USER_EMAIL = "hhsudhan01@gmail.com"
INITIAL_USER_PASSWORD = "hari@1998"
INITIAL_BRANCH_NAME = "Shop 01 - Male'"


def _load_database_url() -> str:
    os.chdir(ROOT)
    sys.path.insert(0, str(ROOT))

    from src import config

    settings = config.load()
    database_url = settings.database_url.strip()
    if not database_url.startswith(("postgresql://", "postgresql+asyncpg://")):
        raise RuntimeError("This reset script only supports PostgreSQL DATABASE_URL values.")
    return database_url


def _psql_url(database_url: str) -> str:
    return database_url.replace("postgresql+asyncpg://", "postgresql://", 1)


def _run(command: list[str], *, env: dict[str, str]) -> str:
    result = subprocess.run(command, cwd=ROOT, env=env, text=True, capture_output=True)
    if result.stdout:
        print(result.stdout, end="")
    if result.returncode:
        if result.stderr:
            print(result.stderr, file=sys.stderr, end="")
        raise RuntimeError(f"Command failed ({result.returncode}): {' '.join(command)}")
    return result.stdout.strip()


async def _bootstrap_schema(database_url: str) -> None:
    from src import config, database

    # Keep the hostname in TLS connections. Some managed PostgreSQL providers
    # reject connections made with a resolved IP because SNI is missing.
    database._prefer_ipv4_host = lambda host, port: host
    config.load()
    await database.init_schema()
    await database.get_engine().dispose()
    database._engine = None
    database._async_sessionmaker = None


async def _seed_initial_setup() -> None:
    from src.database import get_async_session
    from src.models import Branch, Organisation, Role, User, UserBranch
    from src.security import hash_password_async

    session_factory = get_async_session()
    async with session_factory() as db:
        existing_user = (
            await db.execute(select(User).where(User.email == INITIAL_USER_EMAIL))
        ).scalar_one_or_none()
        if existing_user:
            print(f"Initial user already exists: {INITIAL_USER_EMAIL}")
            return

        organisation = (
            await db.execute(
                select(Organisation).where(Organisation.name == INITIAL_ORGANISATION_NAME)
            )
        ).scalar_one_or_none()
        if not organisation:
            organisation = Organisation(
                id="org-initial",
                name=INITIAL_ORGANISATION_NAME,
            )
            db.add(organisation)

        branch = (
            await db.execute(select(Branch).where(Branch.name == INITIAL_BRANCH_NAME))
        ).scalar_one_or_none()
        if not branch:
            branch = Branch(
                id="branch-initial",
                name=INITIAL_BRANCH_NAME,
                code="SM",
                active=True,
            )
            db.add(branch)
            await db.flush()

        role = (await db.execute(select(Role).where(Role.key == "super_admin"))).scalar_one()
        user = User(
            id="user-initial",
            name=INITIAL_USER_NAME,
            email=INITIAL_USER_EMAIL,
            hashed_password=await hash_password_async(INITIAL_USER_PASSWORD),
            role="super_admin",
            role_id=role.id,
            branch_id=branch.id,
            active=True,
            status="active",
            must_change_password=False,
            all_branches=False,
        )
        db.add(user)
        await db.flush()
        db.add(UserBranch(user_id=user.id, branch_id=branch.id))
        await db.commit()
        print(f"Created initial user: {INITIAL_USER_EMAIL}")
        print(f"Created organization: {INITIAL_ORGANISATION_NAME}")
        print(f"Created branch: {INITIAL_BRANCH_NAME}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Confirm the destructive reset. Required to run the command.",
    )
    args = parser.parse_args()
    if not args.yes:
        parser.error("This permanently deletes all data. Re-run with --yes to confirm.")

    database_url = _load_database_url()
    parsed = make_url(database_url)
    target = f"{parsed.host}:{parsed.port or 5432}/{parsed.database}"
    print(f"Resetting PostgreSQL database: {target}")

    env = os.environ.copy()
    env["DATABASE_URL"] = database_url
    psql_url = _psql_url(database_url)

    _run(
        [
            "psql",
            psql_url,
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO public;",
        ],
        env=env,
    )
    asyncio.run(_bootstrap_schema(database_url))

    alembic = str(ROOT / ".venv" / "bin" / "alembic")
    if not Path(alembic).exists():
        raise RuntimeError(f"Project Alembic executable not found: {alembic}")

    _run([alembic, "upgrade", "005_add_invoice_payment_proofs"], env=env)
    _run(
        [
            "psql",
            psql_url,
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            "ALTER TABLE alembic_version ALTER COLUMN version_num TYPE VARCHAR(255);",
        ],
        env=env,
    )
    _run([alembic, "upgrade", "head"], env=env)
    asyncio.run(_seed_initial_setup())
    current = _run([alembic, "current"], env=env)
    table_count = _run(
        [
            "psql",
            psql_url,
            "-Atc",
            "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';",
        ],
        env=env,
    )
    print(f"Migration: {current}")
    print(f"Public tables: {table_count}")


if __name__ == "__main__":
    main()
