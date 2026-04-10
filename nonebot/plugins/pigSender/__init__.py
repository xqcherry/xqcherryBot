import random
import aiohttp
import urllib.parse
from nonebot import on_command, get_driver
from nonebot.plugin import PluginMetadata
from nonebot.adapters.onebot.v11 import MessageSegment, Message
from nonebot.log import logger

__plugin_meta__ = PluginMetadata(
    name="PigSender",
    description="从 pighub.top 获取随机猪猪图片",
    usage="指令：来张猪猪 / 随机猪猪",
    config=None,
)

# 基础配置
BASE_URL = "https://pighub.top"
ALL_IMAGES_API = f"{BASE_URL}/api/all-images"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Referer": f"{BASE_URL}/"
}

_session: aiohttp.ClientSession = None
driver = get_driver()

@driver.on_startup
async def _init_session():
    global _session
    if _session is None or _session.closed:
        _session = aiohttp.ClientSession(headers=HEADERS)
        logger.opt(colors=True).info("<g>[PigHub]</g> 全局 HTTP Session 已初始化")

@driver.on_shutdown
async def _close_session():
    global _session
    if _session:
        await _session.close()
        logger.opt(colors=True).info("<y>[PigHub]</y> 全局 HTTP Session 已关闭")

# 注册指令
get_pig = on_command("来张猪猪", aliases={"随机猪猪"}, priority=5, block=True)

@get_pig.handle()
async def handle_pig():
    try:
        # 保证 session 可用
        if _session is None or _session.closed:
            await _init_session()

        # 1. 获取全量列表
        async with _session.get(ALL_IMAGES_API, timeout=10) as resp:
            resp.raise_for_status()
            data = await resp.json()
            
        images = data.get("images", [])
        if not images:
            await get_pig.finish("猪猪仓库好像空了...")

        # 2. 随机抽样
        target = random.choice(images)
        pig_id = target.get("id", "???")
        title = target.get("title", "没名字的猪猪")
        
        # 3. 构造 URL
        raw_path = target.get("thumbnail") or f"/data/{target.get('filename')}"
        encoded_path = urllib.parse.quote(raw_path)
        img_url = f"{BASE_URL}{encoded_path}"

        # 4. 下载图片二进制流
        logger.info(f"正在抓取猪猪【{title}】: {img_url}")
        async with _session.get(img_url, timeout=15) as img_resp:
            if img_resp.status != 200:
                await get_pig.finish(f"猪猪被图床守卫拦截了 (HTTP {img_resp.status})")
            
            img_bytes = await img_resp.read()
            
            if len(img_bytes) < 1024:
                await get_pig.finish("下载到的猪猪图片不完整...")

        # 5. 发送图片
        await get_pig.send(
            Message(f"No.{pig_id}【{title}】\n") +
            MessageSegment.image(img_bytes)
        )

    except Exception as e:
        logger.error(f"PigHub 插件运行出错: {str(e)}")
        await get_pig.finish("猪猪钻进泥潭里找不到了...")