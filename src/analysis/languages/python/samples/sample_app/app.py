"""Sample app entry point."""
import os
from services.user_service import UserService, get_user
from config import SETTINGS

service = UserService()


def main(user_id: int) -> None:
    user = get_user(user_id)
    # Crash scenario 1: get_user returns None for unknown ids.
    print(user.name)


if __name__ == '__main__':
    main(int(os.environ.get('USER_ID', '1')))
