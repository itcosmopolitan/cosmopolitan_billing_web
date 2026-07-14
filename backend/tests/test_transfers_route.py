import asyncio
from pathlib import Path

from httpx import AsyncClient

from src.main import app
from src.security import create_access_token
from src.database import get_db
from src.models import User
from sqlalchemy import select


async def _get_super_admin_token():
    async for db in get_db():
        result = await db.execute(select(User).where(User.role == 'super_admin'))
        user = result.scalars().first()
        return create_access_token(user.id)


def test_transfers_route_uses_branch_aliases():
    token = asyncio.run(_get_super_admin_token())

    async def _run():
        async with AsyncClient(app=app, base_url='http://test') as client:
            headers = {'Authorization': f'Bearer {token}'}
            response = await client.get('/api/v1/transfers/', params={'branch_id': 'br-002', 'limit': 1}, headers=headers)
            assert response.status_code == 200
            body = response.json()
            assert 'items' in body
            assert 'total' in body

            response2 = await client.get(
                '/api/v1/transfers/',
                params={'from_branch_id': 'br-002', 'to_branch_id': 'br-001', 'limit': 1},
                headers=headers,
            )
            assert response2.status_code == 200
            body2 = response2.json()
            assert 'items' in body2
            assert 'total' in body2
            assert all(
                item['from_branch_id'] == 'br-002' and item['to_branch_id'] == 'br-001'
                for item in body2['items']
            )

    asyncio.run(_run())
