from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Protocol


class ReminderLike(Protocol):
    id: int
    creator_user_id: str
    chat_type: str
    content: str


@dataclass(frozen=True)
class NumberedReminder:
    display_no: int
    row: ReminderLike


def is_explicit_command(plain_text: str, names: Iterable[str]) -> bool:
    text = plain_text.strip()
    for name in names:
        command = f"/{name}"
        if text == command or text.startswith(f"{command} "):
            return True
    return False


def number_rows(rows: list[ReminderLike]) -> list[NumberedReminder]:
    return [NumberedReminder(index, row) for index, row in enumerate(rows, start=1)]


def resolve_cancel_ids(rows: list[ReminderLike], display_numbers: list[int]) -> list[int]:
    by_display_no = {item.display_no: item.row.id for item in number_rows(rows)}
    return [by_display_no[number] for number in display_numbers if number in by_display_no]


def format_due_message(row: ReminderLike) -> str:
    body = f"⏰ 提醒\n{row.content}"
    if row.chat_type == "group":
        return f"[CQ:at,qq={row.creator_user_id}] {body}"
    return body
