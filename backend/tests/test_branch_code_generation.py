from types import SimpleNamespace

from src.routes._serializers import serialize_branch
from src.routes.branches import BranchCreate, _build_branch_code
from src.routes.setup import SetupRequest


def test_build_branch_code_uses_two_letters_from_branch_name():
    assert _build_branch_code("Male") == "MA"


def test_build_branch_code_avoids_existing_codes():
    assert _build_branch_code("Branch", ["BR", "BS"]) == "BT"


def test_branch_create_and_serializer_keep_child_counter_addresses():
    child_counters = [{
        "name": "Shop 01 Male'",
        "street1": "First street",
        "street2": "Building 1",
        "street3": "",
        "city": "Male'",
        "state_province": "Kaafu",
        "country": "Maldives",
        "postal_code": "20001",
    }]
    payload = BranchCreate(
        name="Shop Male'",
        code="SM",
        email="male@example.com",
        has_child_counters=True,
        child_counters=[{
            **child_counters[0],
            "phone": "+960 1234567",
            "email": "counter@example.com",
        }],
    )
    branch = SimpleNamespace(
        id="branch-1",
        name=payload.name,
        code=payload.code,
        phone=None,
        email=payload.email,
        address="Main branch address",
        street1=None,
        street2=None,
        street3=None,
        city=None,
        state_province=None,
        country=None,
        postal_code=None,
        has_child_counters=payload.has_child_counters,
        child_counters=[counter.model_dump(exclude_none=True) for counter in payload.child_counters],
        gstin=None,
        active=True,
    )

    serialized = serialize_branch(branch)

    assert serialized["has_child_counters"] is True
    assert serialized["email"] == "male@example.com"
    assert serialized["child_counters"][0]["phone"] == "+960 1234567"
    assert serialized["child_counters"][0]["email"] == "counter@example.com"
    assert serialized["child_counters"][0]["id"]


def test_legacy_child_counter_address_is_still_accepted():
    payload = BranchCreate(
        name="Shop Male'",
        code="SM",
        has_child_counters=True,
        child_counters=[{"name": "Shop 01 Male'", "address": "First street, Male'"}],
    )

    assert payload.child_counters[0].address == "First street, Male'"


def test_setup_request_accepts_branch_email():
    payload = SetupRequest(
        organizationName="Organization",
        branchName="Male",
        branchEmail="male@example.com",
        adminName="Admin",
        adminEmail="admin@example.com",
    )

    assert payload.branchEmail == "male@example.com"
