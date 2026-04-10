import asyncio, re, json
from pathlib import Path
from nonebot import on_command, get_bot, get_plugin_config
from nonebot.adapters.onebot.v11 import GROUP, GroupMessageEvent, MessageSegment
from nonebot_plugin_apscheduler import scheduler
from pydantic import BaseModel

class Config(BaseModel):
    like_data_filename: str = "data/like/like_data.json"
    like_time: int = 10

conf = get_plugin_config(Config)
DB_PATH = Path(conf.like_data_filename)


def get_db():
    if not DB_PATH.exists(): return {"users": {}}
    return json.loads(DB_PATH.read_text(encoding="utf-8"))

def save_db(data):
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    DB_PATH.write_text(json.dumps(data, indent=4, ensure_ascii=False), encoding="utf-8")

async def do_like(bot, uid):
    try:
        await bot.send_like(user_id=int(uid), times=conf.like_time)
        return True
    except: return False


cmd_like = on_command("赞我", aliases={"赞他", "赞她"}, permission=GROUP, block=True)
cmd_sub = on_command("订阅赞", aliases={"取消订阅赞"}, permission=GROUP, block=True)

@cmd_like.handle()
async def _(bot: Bot, event: GroupMessageEvent):

    target = event.user_id
    for seg in event.get_message():
        if seg.type == "at": target = seg.data["qq"]
    
    if await do_like(bot, target):
        await cmd_like.finish(MessageSegment.at(event.user_id) + " 赞好啦！")
    await cmd_like.finish("点赞失败，可能不是好友或达到上限")

@cmd_sub.handle()
async def _(event: GroupMessageEvent):
    db = get_db()
    uid = str(event.user_id)

    sub = "订阅" in event.get_plaintext()
    
    db["users"][uid] = {"follow": sub, "name": event.sender.nickname}
    save_db(db)
    await cmd_sub.finish(f"已{'开启' if sub else '关闭'}每日自动点赞！")


@scheduler.scheduled_job("cron", hour=5, id="daily_like")
async def _():
    bot = get_bot()
    db = get_db()
    for uid, info in db.get("users", {}).items():
        if info.get("follow"):
            await do_like(bot, uid)
            await asyncio.sleep(3)