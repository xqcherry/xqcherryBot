from nonebot import get_driver
from nonebot.adapters.onebot.v11 import MessageEvent, Bot
from nonebot.message import run_preprocessor
from nonebot.exception import IgnoredException
from nonebot.plugin import PluginMetadata

__plugin_meta__ = PluginMetadata(
    name="全局访问控制",
    description="黑白名单管理插件",
    usage="在插件源码内手动修改名单变量后重启生效",
)

# 是否开启白名单模式（True: 仅名单内可用；False: 所有人可用，黑名单除外）
WHITELIST_MODE = False
# 用户黑名单 (QQ号)
BLACK_USERS = {}
# 群组黑名单 (群号)
BLACK_GROUPS = {1034817756}
# 用户白名单 (QQ号)
WHITE_USERS = {2059928821, 2417185282}
# 群组白名单 (群号)
WHITE_GROUPS = {}

@run_preprocessor
async def _(bot: Bot, event: MessageEvent):

    user_id = int(event.get_user_id())
    group_id = getattr(event, 'group_id', None)
    
    # 0. 超级管理员永远豁免 (读取 .env 中的 SUPERUSERS)
    if str(user_id) in get_driver().config.superusers:
        return

    # 1. 检查黑名单
    if user_id in BLACK_USERS:
        await bot.send(event, "你在黑名单中，无权使用本机器人")
        raise IgnoredException("用户在黑名单")
    
    if group_id and group_id in BLACK_GROUPS:
        raise IgnoredException("群组在黑名单")

    # 2. 白名单判定
    if WHITELIST_MODE:
        is_white_user = user_id in WHITE_USERS
        is_white_group = group_id and group_id in WHITE_GROUPS
        
        if not (is_white_user or is_white_group):
            raise IgnoredException("不在白名单模式允许范围内")
