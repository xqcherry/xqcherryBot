from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import aiosqlite
from nonebot import get_bots, get_driver, logger, on_command
from nonebot.adapters.onebot.v11 import Bot, GroupMessageEvent, Message, MessageEvent, PrivateMessageEvent
from nonebot.params import CommandArg
from nonebot.plugin import PluginMetadata
from nonebot.rule import Rule
from nonebot_plugin_apscheduler import scheduler

from .behavior import format_due_message, is_explicit_command, number_rows, resolve_cancel_ids
from .parser import ReminderParseError, parse_reminder_input


__plugin_meta__ = PluginMetadata(
    name="日程提醒",
    description="支持自然语言时间解析的一次性日程提醒",
    usage=(
        "1. /提醒 明天下午六点 喝水\n"
        "2. /提醒 3小时后 开会\n"
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
    message = format_due_message(row)
    if row.chat_type == "group" and row.group_id:
        await bot.call_api("send_group_msg", group_id=int(row.group_id), message=message)
    else:
        await bot.call_api("send_private_msg", user_id=int(row.creator_user_id), message=message)


def _explicit_reminder_rule(event: MessageEvent) -> bool:
    return is_explicit_command(event.get_plaintext(), {"提醒", "remind"})


def _explicit_list_rule(event: MessageEvent) -> bool:
    return is_explicit_command(event.get_plaintext(), {"提醒列表", "reminders"})


def _explicit_cancel_rule(event: MessageEvent) -> bool:
    return is_explicit_command(event.get_plaintext(), {"取消提醒", "删除提醒"})


remind_cmd = on_command("提醒", aliases={"remind"}, rule=Rule(_explicit_reminder_rule), priority=5, block=True)
list_cmd = on_command("提醒列表", aliases={"reminders"}, rule=Rule(_explicit_list_rule), priority=5, block=True)
cancel_cmd = on_command("取消提醒", aliases={"删除提醒"}, rule=Rule(_explicit_cancel_rule), priority=5, block=True)


@remind_cmd.handle()
async def _(event: MessageEvent, args: Message = CommandArg()):
    raw_args = args.extract_plain_text().strip()
    try:
        parsed = parse_reminder_input(raw_args, now=_now())
    except ReminderParseError as e:
        await remind_cmd.finish(str(e))

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
    display_no = next((item.display_no for item in number_rows(rows) if item.row.id == new_id), new_id)
    await remind_cmd.finish(f"已设置提醒 #{display_no}：{parsed.remind_at:%m-%d %H:%M} {parsed.content}")


@list_cmd.handle()
async def _(event: MessageEvent):
    chat_type, group_id, creator_user_id = _event_scope(event)
    rows = await db_list_reminders(creator_user_id=creator_user_id, chat_type=chat_type, group_id=group_id)
    if not rows:
        await list_cmd.finish("当前没有待提醒日程")

    lines = [f"#{item.display_no} {item.row.remind_at[5:16]} {item.row.content}" for item in number_rows(rows)]
    await list_cmd.finish("⏰ 待提醒日程：\n" + "\n".join(lines))


@cancel_cmd.handle()
async def _(event: MessageEvent, args: Message = CommandArg()):
    raw_args = args.extract_plain_text().strip()
    display_numbers = [int(item) for item in raw_args.split() if item.isdigit()]
    if not display_numbers:
        await cancel_cmd.finish("请输入提醒编号，如：/取消提醒 3")

    chat_type, group_id, creator_user_id = _event_scope(event)
    rows = await db_list_reminders(creator_user_id=creator_user_id, chat_type=chat_type, group_id=group_id)
    ids = resolve_cancel_ids(rows, display_numbers)
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
