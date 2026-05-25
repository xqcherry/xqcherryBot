from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Protocol
from zoneinfo import ZoneInfo

import aiosqlite
from nonebot import get_bots, get_driver, logger, on_command, on_message
from nonebot.adapters.onebot.v11 import Bot, GroupMessageEvent, Message, MessageEvent, PrivateMessageEvent
from nonebot.params import CommandArg
from nonebot.plugin import PluginMetadata
from nonebot.rule import Rule
from nonebot_plugin_apscheduler import scheduler

from .parser import ParsedReminder, ReminderParseError, parse_reminder_input


__plugin_meta__ = PluginMetadata(
    name="日程提醒",
    description="支持自然语言时间解析的一次性日程提醒",
    usage=(
        "1. 群聊 @机器人 提醒 明天下午六点 喝水\n"
        "2. 私聊 提醒 3小时后 开会\n"
        "3. /提醒列表\n"
        "4. /取消提醒 编号"
    ),
)


global_config = get_driver().config
DB_PATH = Path(getattr(global_config, "db_output_path", "/app/db/bot_data.db"))
BEIJING_TZ = ZoneInfo("Asia/Shanghai")


@dataclass(frozen=True)
class ReminderRow:
    id: int
    creator_user_id: str
    chat_type: str
    group_id: str | None
    content: str
    remind_at: str


class ReminderLike(Protocol):
    id: int
    creator_user_id: str
    chat_type: str
    content: str


@dataclass(frozen=True)
class NumberedReminder:
    display_no: int
    row: ReminderLike


def _now() -> datetime:
    return datetime.now(BEIJING_TZ).replace(tzinfo=None, microsecond=0)


def _event_scope(event: MessageEvent) -> tuple[str, str | None, str]:
    if isinstance(event, GroupMessageEvent):
        return "group", str(event.group_id), str(event.user_id)
    if isinstance(event, PrivateMessageEvent):
        return "private", None, str(event.user_id)
    return "private", None, str(event.user_id)


async def db_add_reminder(
    *,
    creator_user_id: str,
    chat_type: str,
    group_id: str | None,
    content: str,
    remind_at: datetime,
    created_at: datetime,
) -> int:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            """
            INSERT INTO reminders (
                creator_user_id, chat_type, group_id, content, remind_at, created_at, status
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending')
            """,
            (
                creator_user_id,
                chat_type,
                group_id,
                content,
                remind_at.isoformat(sep=" "),
                created_at.isoformat(sep=" "),
            ),
        ) as cursor:
            await db.commit()
            return int(cursor.lastrowid)


async def db_list_reminders(*, creator_user_id: str, chat_type: str, group_id: str | None) -> list[ReminderRow]:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            """
            SELECT id, creator_user_id, chat_type, group_id, content, remind_at
            FROM reminders
            WHERE status = 'pending'
              AND creator_user_id = ?
              AND chat_type = ?
              AND COALESCE(group_id, '') = COALESCE(?, '')
            ORDER BY remind_at ASC, id ASC
            """,
            (creator_user_id, chat_type, group_id),
        ) as cursor:
            rows = await cursor.fetchall()
    return [ReminderRow(*row) for row in rows]


async def db_cancel_reminders(ids: list[int], *, creator_user_id: str, chat_type: str, group_id: str | None) -> int:
    if not ids:
        return 0

    placeholders = ",".join("?" for _ in ids)
    params = [*ids, creator_user_id, chat_type, group_id]
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            f"""
            UPDATE reminders
            SET status = 'cancelled'
            WHERE id IN ({placeholders})
              AND status = 'pending'
              AND creator_user_id = ?
              AND chat_type = ?
              AND COALESCE(group_id, '') = COALESCE(?, '')
            """,
            params,
        ) as cursor:
            await db.commit()
            return cursor.rowcount


async def db_get_due_reminders(now: datetime) -> list[ReminderRow]:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            """
            SELECT id, creator_user_id, chat_type, group_id, content, remind_at
            FROM reminders
            WHERE status = 'pending' AND remind_at <= ?
            ORDER BY remind_at ASC, id ASC
            LIMIT 20
            """,
            (now.isoformat(sep=" "),),
        ) as cursor:
            rows = await cursor.fetchall()
    return [ReminderRow(*row) for row in rows]


async def db_mark_sent(reminder_id: int) -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE reminders SET status = 'sent', sent_at = ? WHERE id = ?",
            (_now().isoformat(sep=" "), reminder_id),
        )
        await db.commit()


async def _send_reminder(bot: Bot, row: ReminderRow) -> None:
    message = _format_due_message(row)
    if row.chat_type == "group" and row.group_id:
        await bot.call_api("send_group_msg", group_id=int(row.group_id), message=message)
    else:
        await bot.call_api("send_private_msg", user_id=int(row.creator_user_id), message=message)


def _parse_reminder_creation(plain_text: str, now: datetime | None = None) -> ParsedReminder | None:
    if not plain_text.startswith("提醒"):
        return None
    if len(plain_text) == len("提醒") or not plain_text[len("提醒")].isspace():
        return None

    raw_args = plain_text[len("提醒") :].strip()
    if not raw_args:
        return None
    try:
        return parse_reminder_input(raw_args, now=now or _now())
    except ReminderParseError:
        return None


def _number_rows(rows: list[ReminderLike]) -> list[NumberedReminder]:
    return [NumberedReminder(index, row) for index, row in enumerate(rows, start=1)]


def _resolve_cancel_ids(rows: list[ReminderLike], display_numbers: list[int]) -> list[int]:
    by_display_no = {item.display_no: item.row.id for item in _number_rows(rows)}
    return [by_display_no[number] for number in display_numbers if number in by_display_no]


def _format_due_message(row: ReminderLike) -> str:
    body = f"⏰ 提醒\n{row.content}"
    if row.chat_type == "group":
        return f"[CQ:at,qq={row.creator_user_id}] {body}"
    return body


def _is_slash_command(plain_text: str, name: str) -> bool:
    text = plain_text.strip()
    command = f"/{name}"
    return text == command or text.startswith(f"{command} ")


def _event_mentions_bot(bot: Bot, event: MessageEvent) -> bool:
    bot_id = str(getattr(bot, "self_id", getattr(event, "self_id", "")))
    for segment in getattr(event, "message", []):
        if getattr(segment, "type", None) == "at" and str(getattr(segment, "data", {}).get("qq")) == bot_id:
            return True
    return False


def _creation_plain_text(bot: Bot, event: MessageEvent) -> str | None:
    if isinstance(event, PrivateMessageEvent):
        return event.get_plaintext()
    if isinstance(event, GroupMessageEvent) and _event_mentions_bot(bot, event):
        return event.get_plaintext().lstrip()
    return None


def _strict_reminder_rule(bot: Bot, event: MessageEvent) -> bool:
    plain_text = _creation_plain_text(bot, event)
    return plain_text is not None and _parse_reminder_creation(plain_text) is not None


def _group_unaddressed_reminder_rule(bot: Bot, event: MessageEvent) -> bool:
    if not isinstance(event, GroupMessageEvent) or _event_mentions_bot(bot, event):
        return False
    text = event.get_plaintext().strip()
    return text == "提醒" or text.startswith("提醒 ")


def _explicit_list_rule(event: MessageEvent) -> bool:
    return _is_slash_command(event.get_plaintext(), "提醒列表")


def _explicit_cancel_rule(event: MessageEvent) -> bool:
    return _is_slash_command(event.get_plaintext(), "取消提醒")


ignore_group_remind_msg = on_message(rule=Rule(_group_unaddressed_reminder_rule), priority=1, block=True)
remind_msg = on_message(rule=Rule(_strict_reminder_rule), priority=5, block=True)
list_cmd = on_command("提醒列表", rule=Rule(_explicit_list_rule), priority=5, block=True)
cancel_cmd = on_command("取消提醒", rule=Rule(_explicit_cancel_rule), priority=5, block=True)


@ignore_group_remind_msg.handle()
async def _():
    return


@remind_msg.handle()
async def _(bot: Bot, event: MessageEvent):
    plain_text = _creation_plain_text(bot, event)
    if plain_text is None:
        return

    parsed = _parse_reminder_creation(plain_text)
    if parsed is None:
        return

    chat_type, group_id, creator_user_id = _event_scope(event)
    new_id = await db_add_reminder(
        creator_user_id=creator_user_id,
        chat_type=chat_type,
        group_id=group_id,
        content=parsed.content,
        remind_at=parsed.remind_at,
        created_at=_now(),
    )
    rows = await db_list_reminders(creator_user_id=creator_user_id, chat_type=chat_type, group_id=group_id)
    display_no = next((item.display_no for item in _number_rows(rows) if item.row.id == new_id), new_id)
    await remind_msg.finish(f"已设置提醒 #{display_no}：{parsed.remind_at:%m-%d %H:%M} {parsed.content}")


@list_cmd.handle()
async def _(event: MessageEvent):
    chat_type, group_id, creator_user_id = _event_scope(event)
    rows = await db_list_reminders(creator_user_id=creator_user_id, chat_type=chat_type, group_id=group_id)
    if not rows:
        await list_cmd.finish("当前没有待提醒日程")

    lines = [f"#{item.display_no} {item.row.remind_at[5:16]} {item.row.content}" for item in _number_rows(rows)]
    await list_cmd.finish("⏰ 待提醒日程：\n" + "\n".join(lines))


@cancel_cmd.handle()
async def _(event: MessageEvent, args: Message = CommandArg()):
    raw_args = args.extract_plain_text().strip()
    display_numbers = [int(item) for item in raw_args.split() if item.isdigit()]
    if not display_numbers:
        await cancel_cmd.finish("请输入提醒编号，如：/取消提醒 3")

    chat_type, group_id, creator_user_id = _event_scope(event)
    rows = await db_list_reminders(creator_user_id=creator_user_id, chat_type=chat_type, group_id=group_id)
    ids = _resolve_cancel_ids(rows, display_numbers)
    affected = await db_cancel_reminders(ids, creator_user_id=creator_user_id, chat_type=chat_type, group_id=group_id)
    if affected:
        await cancel_cmd.finish(f"已取消 {affected} 条提醒")
    await cancel_cmd.finish("未找到可取消的提醒")


@scheduler.scheduled_job("interval", seconds=30, id="dispatch_due_reminders", max_instances=1)
async def dispatch_due_reminders():
    bots = list(get_bots().values())
    if not bots:
        return

    bot = bots[0]
    rows = await db_get_due_reminders(_now())
    for row in rows:
        try:
            await _send_reminder(bot, row)
            await db_mark_sent(row.id)
        except Exception as e:
            logger.error(f"【日程提醒】发送提醒 #{row.id} 失败: {e}")
