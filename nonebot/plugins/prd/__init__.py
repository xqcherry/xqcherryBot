from datetime import datetime, timedelta, timezone
from nonebot import on_command, logger
from nonebot.adapters.onebot.v11 import MessageEvent, Message
from nonebot.params import CommandArg
from nonebot.plugin import PluginMetadata
from common.json_utils import JsonUtils


__plugin_meta__ = PluginMetadata(
    name="prd",
    description="需求管理",
    usage=(
        "1. 添加: /prd add 内容\n"
        "2. 查看: /prd ls\n"
        "3. 完成: /prd ok 编号"
        "3. 删除: /prd rm 编号"
    )
)

# 配置常量
DATA_FILE = "prd_data.json"

prd = on_command("prd", priority=5, block=True)

@prd.handle()
async def _(event: MessageEvent, args: Message = CommandArg()):
    raw_args = args.extract_plain_text().strip()
    params = raw_args.split()

    # 默认提示
    if not params:
        await prd.finish("🛠️ PRD 精简版用法：\n1. /prd add [内容] - 添加需求\n2. /prd ls - 查看未完成\n3. /prd ok [编号] - 标记完成")

    op = params[0].lower()
    data, _ = JsonUtils.read(DATA_FILE, {"to_do": []})
    to_do = data["to_do"]

    # 1. 添加需求
    if op == "add":
        content = " ".join(params[1:])
        if not content:
            await prd.finish("请输入需求内容")
            
        new_id = (to_do[-1]["id"] + 1) if to_do else 1
        tz_bj = timezone(timedelta(hours=8))
        beijing_time = datetime.now(tz_bj)
        new_item = {
            "id": new_id,
            "content": content,
            "finish": False,
            "time": beijing_time.strftime("%m-%d %H:%M")
        }
        to_do.append(new_item)
        JsonUtils.write(DATA_FILE, {"to_do": to_do})
        await prd.finish(f"已记录需求 #{new_id}")

    # 2. 查看需求
    elif op in ["ls", "list"]:
        # 仅过滤未完成的任务
        unfinished = [f"#{item['id']} {item['content']} ({item['time']})" 
                      for item in to_do if not item.get("finish")]
        
        if not unfinished:
            await prd.finish("当前没有待办需求，休息一下吧！")
        
        msg = "📝 待办需求清单：\n" + "\n".join(unfinished)
        await prd.finish(msg)

    # 3. 标记完成
    elif op in ["ok", "done", "rm"]:
        ids_to_delete = [int(sid) for sid in params[1:] if sid.isdigit()]
        if not ids_to_delete:
            await prd.finish("请输入编号，如：/prd ok 1 2")

        new_to_do = [item for item in to_do if item["id"] not in ids_to_delete]
        
        if len(new_to_do) < len(to_do):
            success_ids = [str(i) for i in ids_to_delete]
            
            to_do = new_to_do
            JsonUtils.write(DATA_FILE, {"to_do": to_do})
            
            await prd.finish(f"需求 #{', '.join(success_ids)} 已清理")
        else:
            await prd.finish("未找到对应的待办编号")

    else:
        await prd.finish("未知指令，输入 /prd 查看说明")

