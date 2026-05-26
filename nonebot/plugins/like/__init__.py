import asyncio
import re
from pathlib import Path
import aiosqlite

from nonebot import on_command, get_bot, get_plugin_config, get_driver, logger
from nonebot.adapters.onebot.v11 import Bot, GroupMessageEvent, PrivateMessageEvent, MessageSegment
from nonebot.adapters.onebot.v11.exception import ActionFailed
from nonebot_plugin_apscheduler import scheduler
from nonebot.plugin import PluginMetadata
from pydantic import BaseModel

class Config(BaseModel):
    like_time: int = 10
    like_loop: int = 5

__plugin_meta__ = PluginMetadata(
    name="QQ点赞",
    description="支持手动点赞与每日定时自动点赞",
    usage=(
        "1. 赞我 / 赞 @某人 / 赞 QQ号：手动触发名片点赞\n"
        "2. 订阅赞：开启每日早晨 5:00 自动点赞\n"
        "3. 取消订阅赞：关闭自动点赞"
    ),
    config=Config,
    extra={"help_order": 20},
)

conf = get_plugin_config(Config)
global_config = get_driver().config
DB_PATH = Path(getattr(global_config, "db_output_path", "/app/db/bot_data.db"))


async def db_get_subscribed_users() -> list[int]:
    """获取所有开启了自动点赞的用户 QQ 号"""
    async with aiosqlite.connect(DB_PATH) as db:
        # 只取 follow = 1 的用户
        async with db.execute("SELECT user_id FROM like_subscribers WHERE follow = 1") as cursor:
            rows = await cursor.fetchall()
            return [int(row[0]) for row in rows]

async def db_update_subscription(user_id: int, nickname: str, follow: bool):
    """更新或插入用户的订阅状态"""
    follow_val = 1 if follow else 0
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO like_subscribers (user_id, nickname, follow) 
            VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET 
                nickname = excluded.nickname,
                follow = excluded.follow
            """,
            (str(user_id), nickname, follow_val)
        )
        await db.commit()


async def do_like(bot: Bot, uid: int) -> tuple[bool, str]:
    """循环点赞和详细错误捕获"""
    success_count = 0
    try:
        for _ in range(conf.like_loop):
            try:
                await bot.send_like(user_id=uid, times=conf.like_time)
                success_count += 1
                await asyncio.sleep(0.8)
            except ActionFailed as e:
                error_msg = e.info.get("message", "")
                if "上限" in error_msg:
                    if success_count > 0:
                        return True, f"点赞成功！发送了 {success_count * conf.like_time} 个赞（已达今日上限）"
                    return False, "今日点赞次数已达上限，明天再来吧~"
                raise e
        return True, f"成功发送 {success_count * conf.like_time} 个赞"
    except ActionFailed as e:
        msg = e.info.get("message", "次数已达上限或非好友")
        return success_count > 0, msg
    except Exception as e:
        return False, f"点赞失败: {str(e)}"


cmd_like = on_command("赞我", aliases={"赞他", "赞她"}, block=True)
cmd_sub = on_command("订阅赞", aliases={"取消订阅赞"}, block=True)

@cmd_like.handle()
async def _(bot: Bot, event: GroupMessageEvent | PrivateMessageEvent):
    if isinstance(event, PrivateMessageEvent):
        await cmd_like.finish("点赞功能只能在群聊使用哦！")
    
    target = event.user_id
    msg_str = event.get_plaintext()

    for seg in event.get_message():
        if seg.type == "at":
            target = int(seg.data["qq"])
            break
    else:
        qq_match = re.search(r"[1-9]\d{4,11}", msg_str)
        if qq_match:
            target = int(qq_match.group())
    
    ok, res = await do_like(bot, target)
    if target == event.user_id:
        await cmd_like.finish(MessageSegment.at(event.user_id) + f" {res}")
    else:
        await cmd_like.finish(MessageSegment.at(target) + f" {res}")

@cmd_sub.handle()
async def _(event: GroupMessageEvent | PrivateMessageEvent):
    if isinstance(event, PrivateMessageEvent):
        await cmd_sub.finish("订阅功能只能在群聊使用哦！")
        
    uid = event.user_id
    nickname = event.sender.nickname or "未知用户"
    is_sub = "取消" not in event.get_plaintext()

    await db_update_subscription(user_id=uid, nickname=nickname, follow=is_sub)
    
    state = "开启" if is_sub else "关闭"
    await cmd_sub.finish(f"已为 {nickname} {state}每日自动点赞！")


@scheduler.scheduled_job("cron", hour=5, id="daily_like")
async def _():
    try:
        bot = get_bot()
    except:
        from nonebot import get_bots
        bots = list(get_bots().values())
        if not bots: 
            return
        bot = bots[0]

    subscribed_uids = await db_get_subscribed_users()
    for uid in subscribed_uids:
        await do_like(bot, uid)
        await asyncio.sleep(3)
