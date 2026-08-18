"""Validation helpers."""


def validate_depth(depth: int) -> int:
    """Recurse forever — crash scenario 2 (RecursionError)."""
    return validate_depth(depth + 1)
