from src.routes.branches import _build_branch_code


def test_build_branch_code_uses_two_letters_from_branch_name():
    assert _build_branch_code("Male") == "MA"


def test_build_branch_code_avoids_existing_codes():
    assert _build_branch_code("Branch", ["BR", "BS"]) == "BT"
