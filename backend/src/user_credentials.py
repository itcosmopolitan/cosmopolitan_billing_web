"""Credential generation for users created without an email address."""

from __future__ import annotations

import secrets
import string
import unicodedata
from typing import Callable


SINGLE_NAME_STRATEGY = "first_7"
TEMP_PASSWORD_LENGTH = 12
_PASSWORD_GROUPS = (
    string.ascii_lowercase,
    string.ascii_uppercase,
    string.digits,
    "!@#$%^&*",
)


def _ascii_name_tokens(full_name: str) -> list[str]:
    normalized = unicodedata.normalize("NFKD", full_name or "")
    ascii_name = normalized.encode("ascii", "ignore").decode("ascii")
    return ["".join(char for char in token.lower() if char.isalpha()) for token in ascii_name.split()]


def generate_username(full_name: str, *, single_name_strategy: str = SINGLE_NAME_STRATEGY) -> str:
    """Generate the base username from a person's name."""
    tokens = [token for token in _ascii_name_tokens(full_name) if token]
    if not tokens:
        return "user"

    first_name = tokens[0]
    if len(tokens) == 1:
        if single_name_strategy == "first_7":
            return first_name[:7]
        if single_name_strategy == "first_5_repeat_last":
            return first_name[:5] + (first_name[-1:] * min(2, len(first_name)))
        raise ValueError(f"Unsupported single-name strategy: {single_name_strategy}")

    return first_name[:5] + tokens[-1][:2]


async def unique_username(base_username: str, exists: Callable[[str], object]) -> str:
    """Return the first available username using numeric suffixes."""
    candidate = base_username or "user"
    suffix = 1
    while await exists(candidate):
        suffix += 1
        candidate = f"{base_username or 'user'}{suffix}"
    return candidate


def generate_temp_password(length: int = TEMP_PASSWORD_LENGTH) -> str:
    """Generate a cryptographically random password with four character classes."""
    if length < len(_PASSWORD_GROUPS):
        raise ValueError("Temporary password length is too short")
    required = [secrets.choice(group) for group in _PASSWORD_GROUPS]
    alphabet = "".join(_PASSWORD_GROUPS)
    required.extend(secrets.choice(alphabet) for _ in range(length - len(required)))
    secrets.SystemRandom().shuffle(required)
    return "".join(required)