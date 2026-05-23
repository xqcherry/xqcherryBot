import random
import httpx
from pydantic import BaseModel, Field
from nonebot import on_command, logger, get_plugin_config
from nonebot.adapters.onebot.v11 import MessageSegment, MessageEvent
from nonebot.plugin import PluginMetadata
from nonebot_plugin_apscheduler import scheduler

# ==================== 1. 环境变量/配置读取 ====================
class Config(BaseModel):
    local_tailscale_ip: str = Field(default="100.11.22.33")
    local_port: str = Field(default="39425")
    whitelist_qq: set[int] = Field(default_factory=lambda: {2417185282, 2303866129})

__plugin_meta__ = PluginMetadata(
    name="pngSender",
    description="通过Tailscale在本地随机抽取照片发送",
    usage="指令：来张美照 / 看看美照",
    config=Config,
)

plugin_config = get_plugin_config(Config)

API_URL = f"http://{plugin_config.local_tailscale_ip}:{plugin_config.local_port}/list"
IMAGE_BASE_URL = f"http://{plugin_config.local_tailscale_ip}:{plugin_config.local_port}/images"
WHITELIST_QQ = plugin_config.whitelist_qq
PHOTO_CACHE = []
# =============================================================

async def scan_photos_from_local_fastapi():
    """从本地电脑的 FastAPI 获取全部多级图片缓存"""
    global PHOTO_CACHE
    logger.info("【pngSender】正在通过 FastAPI 同步本地电脑照片索引...")
    
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(API_URL)
            if response.status_code == 200:
                data = response.json()
                PHOTO_CACHE = data.get("photos", [])
                logger.info(f"【pngSender】同步完成！共发现 {len(PHOTO_CACHE)} 张照片（含子文件夹）")
            else:
                logger.error(f"【pngSender】无法访问本地 FastAPI，HTTP 状态码: {response.status_code}")
    except Exception as e:
        logger.error(f"【pngSender】连接本地 FastAPI 失败。错误: {e}")


@scheduler.scheduled_job("interval", weeks=1, id="refresh_fastapi_photos")
async def auto_refresh():
    await scan_photos_from_local_fastapi()


# 启动时同步一次
from nonebot import get_driver
@get_driver().on_startup
async def init_photos():
    await scan_photos_from_local_fastapi()


get_png = on_command("来张美照", aliases={"看看美照", "随机美照"}, priority=5, block=True)

@get_png.handle()
async def handle_png(event: MessageEvent):

    # 1. 权限校验
    if event.user_id not in WHITELIST_QQ:
        await get_png.finish("哼，这张照片才不给你看呢！")

    # 2. 检查缓存
    if not PHOTO_CACHE:
        await scan_photos_from_local_fastapi()
        if not PHOTO_CACHE:
            await get_png.finish("喵喵喵，本地照片库空空如也，或者是跟本地电脑失联了~")

    # 3. 随机抽取相对路径并拼接成静态直链
    target_relative_path = random.choice(PHOTO_CACHE)
    photo_url = f"{IMAGE_BASE_URL}/{target_relative_path}"

    try:
        # NapCat 会通过 Tailscale 隧道流式读取本地电脑图片并发送出去
        await get_png.send(MessageSegment.image(photo_url))
        logger.info(f"【pngSender】成功发送本地图片: {target_relative_path}")
    except Exception as e:
        logger.error(f"【pngSender】发送图片失败, 错误: {e}")
        await get_png.finish("喵喵喵，照片发送失败了，可能网络开小差了呢~")