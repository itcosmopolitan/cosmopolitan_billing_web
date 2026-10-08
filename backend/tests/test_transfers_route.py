import asyncio
from pathlib import Path

from httpx import AsyncClient

from src.main import app
from src.security import create_access_token
from src.database import get_db
from src.models import Item, TransferLineItem, User
from src.routes.transfers import (
    TransferCreate,
    TransferLine,
    _line_dict,
    create_transfer,
)
from sqlalchemy import select


def test_transfer_line_serializer_includes_inventory_packing_and_unit():
    item = Item(id='item-1', name='Transfer item', packaging='1x15KG', unit='KG')
    line = TransferLineItem(
        item_id='item-1',
        item_name='Transfer item',
        qty=4,
        item=item,
    )

    assert _line_dict(line) == {
        'item_id': 'item-1',
        'name': 'Transfer item',
        'packing': '1x15KG',
        'unit': 'KG',
        'qty': 4,
        'cost_price': 0,
        'preferred_batch_id': None,
        'requested_allocation': [],
        'batches': [],
    }
    assert _line_dict(line, cost_price=12.5)['cost_price'] == 12.5
    line.cost_price = 18.75
    assert _line_dict(line, cost_price=12.5)['cost_price'] == 18.75


def test_create_transfer_only_requires_source_branch_access(monkeypatch):
    async def _run():
        scope_checks = []

        async def resolve_branch_scope(user, db, branch_id):
            scope_checks.append(branch_id)
            return ["source"]

        async def validate_child_counter(db, branch_id, child_counter_id, child_counter_name):
            return None, None

        async def allocate_number(db, document_type, branch_id):
            return "TR-001"

        async def branch_names(db, from_id, to_id):
            return "Source", "Destination"

        async def can_direct_commit(user, db, permission):
            return False

        class FakeDB:
            def add(self, value):
                pass

            async def flush(self):
                pass

            async def commit(self):
                pass

        monkeypatch.setattr("src.routes.transfers._resolve_branch_scope", resolve_branch_scope)
        monkeypatch.setattr("src.routes.transfers.validate_child_counter", validate_child_counter)
        monkeypatch.setattr("src.routes.transfers.allocate_number", allocate_number)
        monkeypatch.setattr("src.routes.transfers._branch_names", branch_names)
        monkeypatch.setattr("src.routes.transfers.can_direct_commit", can_direct_commit)
        monkeypatch.setattr("src.routes.transfers._log_transfer_history", lambda *args, **kwargs: None)

        result = await create_transfer(
            TransferCreate(
                from_branch_id="source",
                to_branch_id="destination",
                requested_by="Transfer user",
                items=[TransferLine(item_id="item-1", item_name="Transfer item", qty=1)],
            ),
            db=FakeDB(),
            user=type("TransferUser", (), {"id": "user-1", "name": "Transfer user"})(),
        )

        assert scope_checks == ["source"]
        assert result["status"] == "draft"

    asyncio.run(_run())


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
