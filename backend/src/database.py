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

