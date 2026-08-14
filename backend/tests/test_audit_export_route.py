import asyncio

from httpx import AsyncClient
from sqlalchemy import select

from src.database import get_db
from src.main import app
from src.models import User
from src.security import create_access_token


async def _get_super_admin_token():
    async for db in get_db():
        result = await db.execute(select(User).where(User.role == 'super_admin'))
        user = result.scalars().first()
        if user is None:
            raise RuntimeError('No super_admin user found for audit export test')
        return create_access_token(user.id)


def test_audit_export_csv_accepts_branch_id_filter():
    token = asyncio.run(_get_super_admin_token())

    async def _run():
        async with AsyncClient(app=app, base_url='http://test') as client:
            headers = {'Authorization': f'Bearer {token}'}
            response = await client.get(
                '/api/v1/audit/export/csv',
                params={'branch_id': 'br-001', 'limit': 1},
                headers=headers,
            )
            assert response.status_code == 200, response.text
            assert response.headers['content-type'].startswith('text/csv')

    asyncio.run(_run())
