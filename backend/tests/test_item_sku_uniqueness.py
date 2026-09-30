import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from src.database import Base
from src.models import Item
from src.routes.items import _validate_unique_sku


async def _build_session() -> AsyncSession:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    session_factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    return session_factory()


@pytest.mark.asyncio
async def test_sku_duplicate_check_is_case_and_whitespace_insensitive():
    db = await _build_session()
    try:
        db.add(Item(id="item-1", name="First item", sku="ITEM-001"))
        await db.commit()

        with pytest.raises(HTTPException) as exc_info:
            await _validate_unique_sku(" item-001 ", db)

        assert exc_info.value.status_code == 409
        assert exc_info.value.detail == "SKU already exists: item-001"
    finally:
        await db.close()