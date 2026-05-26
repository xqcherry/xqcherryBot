from nonebot import get_driver, get_plugin_config
from nonebot.adapters.onebot.v11 import MessageEvent, Bot
from nonebot.message import run_preprocessor
from nonebot.exception import IgnoredException
from nonebot.plugin import PluginMetadata
from pydantic import BaseModel, Field
from typing import Set

__plugin_meta__ = PluginMetadata(
    name="全局访问控制",
    description="黑白名单管理",
    usage="在 .env 文件中配置对应的环境变量",
    extra={"hidden": True},
)

# 1. 定义配置模型
class Config(BaseModel):
    access_control_whitelist_mode: bool = True
    
    access_control_black_users: Set[int] = Field(default_factory=set)
    access_control_black_groups: Set[int] = Field(default_factory=set)
    access_control_white_users: Set[int] = Field(default_factory=set)
    access_control_white_groups: Set[int] = Field(default_factory=set)

# 2. 实例化配置
global_config = get_driver().config
plugin_config = get_plugin_config(Config)

@run_preprocessor
async def _(bot: Bot, event: MessageEvent):
    user_id = int(event.get_user_id())
    group_id = getattr(event, 'group_id', None)
    
    # 0. 超级管理员永远豁免
    if str(user_id) in global_config.superusers:
        return

    # 1. 检查黑名单
    if user_id in plugin_config.access_control_black_users:
        await bot.send(event, "你在黑名单中，无权使用本机器人")
        raise IgnoredException("用户在黑名单")
    
    if group_id and group_id in plugin_config.access_control_black_groups:
        raise IgnoredException("群组在黑名单")

    # 2. 白名单判定
    if plugin_config.access_control_whitelist_mode:
        is_white_user = user_id in plugin_config.access_control_white_users
        is_white_group = group_id and group_id in plugin_config.access_control_white_groups
        
        if not (is_white_user or is_white_group):
            raise IgnoredException("不在白名单模式允许范围内")
