from src.permissions import PERMISSIONS, expand, filter_valid, is_valid


def test_document_specific_permissions_are_in_catalog():
    for module in ("quotations", "sales_orders", "bills", "grns"):
        assert PERMISSIONS[module] == [
            "view", "create", "edit", "delete", "export", "approve",
        ]
        assert is_valid(f"{module}.edit")
        assert is_valid(f"{module}.*")


def test_document_specific_permissions_round_trip_through_role_filter():
    permissions = [
        "quotations.edit",
        "sales_orders.view",
        "bills.create",
        "grns.approve",
        "not_a_permission.edit",
    ]
    filtered = filter_valid(permissions)

    assert filtered == permissions[:-1]
    assert expand(filtered) == set(permissions[:-1])
