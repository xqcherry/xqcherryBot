from datetime import datetime, timedelta, timezone
from pathlib import Path
import aiosqlite

from nonebot import on_command, logger, get_driver
from nonebot.adapters.onebot.v11 import MessageEvent, Message
from nonebot.params import CommandArg
from nonebot.plugin import PluginMetadata

__plugin_meta__ = PluginMetadata(
    name="需求管理",
    description="支持 SQLite 增删改查的精简版需求管理工具",
    usage=(
        "1. 添加: /prd add 内容\n"
        "2. 查看: /prd ls\n"
        "3. 完成: /prd ok 编号\n"
        "4. 删除: /prd rm 编号"
    )
)

global_config = get_driver().config
DB_PATH = Path(getattr(global_config, "db_output_path", "/app/db/bot_data.db"))


async def db_add_prd(content: str, time_str: str) -> int:
    """插入新需求，返回生成的主键 ID"""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "INSERT INTO prd_tasks (content, create_time, finish) VALUES (?, ?, 0)",
            (content, time_str)
        ) as cursor:
            await db.commit()
            return cursor.lastrowid

async def db_get_unfinished_prds() -> list[tuple]:
    """获取所有未完成的需求列表"""
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT id, content, create_time FROM prd_tasks WHERE finish = 0 ORDER BY id ASC"
        ) as cursor:
            return await cursor.fetchall()

async def db_delete_prds(ids: list[int]) -> int:
    """批量删除指定的编号，返回实际影响的行数"""
    if not ids:
        return 0

    placeholders = ",".join("?" for _ in ids)
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            f"DELETE FROM prd_tasks WHERE id IN ({placeholders})", 
            ids
        ) as cursor:
            await db.commit()
            return cursor.rowcount


prd = on_command("prd", priority=5, block=True)

@prd.handle()
async def _(event: MessageEvent, args: Message = CommandArg()):
    raw_args = args.extract_plain_text().strip()
    params = raw_args.split()

    if not params:
        await prd.finish(
            "🛠️ PRD 精简版用法：\n"
            "1. /prd add [内容] - 添加需求\n"
            "2. /prd ls - 查看未完成\n"
            "3. /prd ok [编号] - 标记完成/清理"
        )

    op = params[0].lower()

    # 1. 添加需求
    if op == "add":
        content = " ".join(params[1:])
        if not content:
            await prd.finish("请输入需求内容")
            
        tz_bj = timezone(timedelta(hours=8))
        beijing_time = datetime.now(tz_bj)
        time_str = beijing_time.strftime("%m-%d %H:%M")
        
        # 写入 SQLite 并获取自增 ID
        new_id = await db_add_prd(content, time_str)
        await prd.finish(f"已记录需求 #{new_id}")

    # 2. 查看需求
    elif op in ["ls", "list"]:
        rows = await db_get_unfinished_prds()
        if not rows:
            await prd.finish("当前没有待办需求，休息一下吧！")
        
        unfinished = [f"#{row[0]} {row[1]} ({row[2]})" for row in rows]
        msg = "📝 待办需求清单：\n" + "\n".join(unfinished)
        await prd.finish(msg)

    # 3. 标记完成 / 删除
    elif op in ["ok", "done", "rm"]:
        ids_to_delete = [int(sid) for sid in params[1:] if sid.isdigit()]
        if not ids_to_delete:
            await prd.finish("请输入编号，如：/prd ok 1 2")

        # 异步调用批量删除
        affected_rows = await db_delete_prds(ids_to_delete)
        
        if affected_rows > 0:
            success_ids = [str(i) for i in ids_to_delete]
            await prd.finish(f"需求 #{', '.join(success_ids)} 已清理")
        else:
            await prd.finish("未找到对应的待办编号")

    else:
        await prd.finish("未知指令，输入 /prd 查看说明")