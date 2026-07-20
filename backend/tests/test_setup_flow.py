from src.routes.setup import is_setup_required


def test_setup_wizard_is_required_when_users_and_branches_are_empty():
    assert is_setup_required(0, 0) is True


def test_setup_wizard_is_not_required_after_initial_data_exists():
    assert is_setup_required(1, 0) is False
    assert is_setup_required(0, 1) is False
    assert is_setup_required(1, 1) is False
