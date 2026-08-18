"""User model."""


class User:
    """A user account."""

    def __init__(self, name: str, email: str):
        self.name = name
        self.email = email

    def display_name(self) -> str:
        return self.name or 'anonymous'
