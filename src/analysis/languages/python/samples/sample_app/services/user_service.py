"""User lookup service."""
from models.user import User

_USERS = {
    1: User('alice', 'alice@example.com'),
    2: User('bob', 'bob@example.com'),
}


def get_user(user_id: int):
    """Return the user with the given id, or None if not found."""
    user = _USERS.get(user_id)
    if user is None:
        return None
    return user


class UserService:
    """Service wrapper around user lookups."""

    def get_user(self, user_id: int):
        user = _USERS.get(user_id)
        if user is None:
            return None
        return user

    def find_or_create(self, user_id: int):
        user = self.get_user(user_id)
        return user or User('guest', '')
