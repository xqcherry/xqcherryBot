from pathlib import Path
from nonebot import get_loaded_plugins, on_command
from nonebot.adapters.onebot.v11 import MessageSegment
from nonebot.exception import FinishedException
from nonebot.plugin import PluginMetadata
from common.help_menu import collect_plugin_help
from common.render import html2pic

__plugin_meta__ = PluginMetadata(
    name="帮助菜单",
    description="显示机器人所有功能的指令清单",
    usage="帮助 | 菜单 | help | ls",
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

help_cmd = on_command("ls", aliases={"帮助", "菜单", "help"}, priority=5, block=True)

@help_cmd.handle()
async def handle_help():
    try:
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
