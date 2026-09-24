from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.user_credentials import generate_temp_password, generate_username, unique_username


def test_generate_username_uses_first_and_last_name():
    assert generate_username("Raghvendra Pratap Singh") == "raghvsi"
    assert generate_username("Hariharasudhan Sankaralingam") == "harihsa"


def test_generate_username_handles_single_and_short_names():
    assert generate_username("Madonna") == "madonna"
    assert generate_username("Al Roy") == "alro"
    assert generate_username("Jo Li") == "joli"


def test_generate_username_ignores_middle_names_and_normalizes_input():
    assert generate_username("  Anne-Marie O'Neil ") == "annemon"
    assert generate_username("José García") == "josega"
    assert generate_username("李") == "user"


def test_single_name_strategy_is_configurable():
    assert generate_username("Ravi", single_name_strategy="first_5_repeat_last") == "raviii"


def test_unique_username_appends_and_checks_suffixes():
    taken = {"raghvsi", "raghvsi2", "raghvsi3"}

    async def exists(username):
        return username in taken

    import asyncio
    assert asyncio.run(unique_username("raghvsi", exists)) == "raghvsi4"


def test_temp_password_has_length_complexity_and_is_not_repeated():
    first = generate_temp_password()
    second = generate_temp_password()
    assert len(first) == 12
    assert any(char.islower() for char in first)
    assert any(char.isupper() for char in first)
    assert any(char.isdigit() for char in first)
    assert any(char in "!@#$%^&*" for char in first)
    assert first != second