from pathlib import Path
from nonebot import get_loaded_plugins, on_command
from nonebot.adapters.onebot.v11 import MessageSegment
from nonebot.exception import FinishedException
from nonebot.params import CommandArg
from nonebot.plugin import PluginMetadata
from nonebot.adapters import Message
from common.help_menu import (
    collect_plugin_help,
    find_plugin_help,
    format_plugin_detail,
    format_plugin_not_found,
)
from common.render import html2pic

__plugin_meta__ = PluginMetadata(
    name="帮助菜单",
    description="显示机器人所有功能的指令清单",
    usage="help\nhelp <插件名>",
    config=None,
    extra={"hidden": True},
)

TEMPLATE_PATH = Path(__file__).parent

def get_all_plugins_info():
    return collect_plugin_help(get_loaded_plugins())

async def render_help_img():

    data = get_all_plugins_info()
    
    img_bytes = await html2pic(
        template_path=str(TEMPLATE_PATH),
        template_name="muji.html",
        plugins=data
    )
    return img_bytes

help_cmd = on_command("help", priority=5, block=True)

@help_cmd.handle()
async def handle_help(args: Message = CommandArg()):
    try:
        plugin_name = args.extract_plain_text().strip()
        if plugin_name:
            plugins = get_loaded_plugins()
            item = find_plugin_help(plugins, plugin_name)
            if item:
                await help_cmd.finish(format_plugin_detail(item))
            await help_cmd.finish(format_plugin_not_found(plugin_name, plugins))

        img_bytes = await render_help_img()
        if img_bytes:
            await help_cmd.finish(MessageSegment.image(img_bytes)) 
        else:
            await help_cmd.finish("图片渲染结果为空")
    except FinishedException:
        raise 
    except Exception as e:
        import traceback
        print(traceback.format_exc())
        await help_cmd.finish(f"菜单渲染失败... 错误原因：{e}")
