import asyncio
import logging
import os
import socket
from urllib.parse import urlparse, unquote

import asyncpg

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger("cosmopolitan.db_healthcheck")


def normalize_database_url(raw_url: str) -> str:
    if raw_url.startswith("postgresql+asyncpg://"):
        return raw_url.replace("postgresql+asyncpg://", "postgresql://", 1)
    if raw_url.startswith("postgresql://"):
        return raw_url
    raise ValueError(
        "DATABASE_URL must use a PostgreSQL connection string, e.g. postgresql+asyncpg://user:pass@host:port/db"
    )


def parse_connection_info(dsn: str) -> tuple[str, int, str, str]:
    parsed = urlparse(dsn)
    hostname = parsed.hostname or ""
    port = parsed.port or 5432
    database = parsed.path.lstrip("/")
    username = unquote(parsed.username or "")
    return hostname, port, database, username


def verify_dns(host: str, port: int) -> None:
    try:
        socket.getaddrinfo(host, port, family=socket.AF_UNSPEC, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise RuntimeError(
            f"DNS resolution failed for {host}:{port}. Verify host name, network access, and DNS settings."
        ) from exc


async def _should_use_ssl(host: str) -> bool:
    sslmode = os.getenv("PGSSLMODE") or os.getenv("PGSSL_MODE")
    if sslmode and sslmode.lower() != "disable":
        return True
    return host not in ("localhost", "127.0.0.1", "::1")


async def main() -> None:
    raw_url = os.getenv("DATABASE_URL")
    if not raw_url:
        raise RuntimeError("DATABASE_URL environment variable is not set.")

    dsn = normalize_database_url(raw_url.strip())
    host, port, database, username = parse_connection_info(dsn)

    if not host or not database or not username:
        raise RuntimeError("DATABASE_URL must include host, database name, and username.")

    logger.info("Checking PostgreSQL connection to %s:%s/%s as user=%s", host, port, database, username)
    verify_dns(host, port)

    connect_kwargs = {"timeout": 10}
    if await _should_use_ssl(host):
        connect_kwargs["ssl"] = True
        logger.info("Using SSL for PostgreSQL healthcheck connection")

    try:
        conn = await asyncpg.connect(dsn=dsn, **connect_kwargs)
    except Exception as exc:
        raise RuntimeError(
            "Could not connect to PostgreSQL. Verify DATABASE_URL, network access, credentials, and pg_hba.conf."
        ) from exc

    try:
        value = await conn.fetchval("SELECT 1")
        logger.info("PostgreSQL reachability validated: SELECT 1 = %s", value)
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
