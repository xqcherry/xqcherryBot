import random
from pathlib import Path
from nonebot import on_command, logger
from nonebot.adapters.onebot.v11 import MessageSegment, MessageEvent
from nonebot.plugin import PluginMetadata
from nonebot_plugin_apscheduler import scheduler

__plugin_meta__ = PluginMetadata(
    name="pngSender",
    description="从 本地库 随机抽取照片发送",
    usage="指令：来张美照 / 看看美照",
    config=None,
)

IMG_PATH = Path("/app/photos") 
WHITELIST_QQ = {2417185282, 2683361634, 2303866129}
VALID_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
PHOTO_CACHE = []


def scan_photos():
    """扫描磁盘并更新内存索引"""
    global PHOTO_CACHE
    if not IMG_PATH.exists():
        logger.error(f"【pngSender】路径 {IMG_PATH} 不存在，请检查 Docker 挂载！")
        return
    
    new_photos = [
        f for f in IMG_PATH.rglob("*") 
        if f.is_file() and f.suffix.lower() in VALID_EXTENSIONS
    ]
    PHOTO_CACHE = new_photos
    logger.info(f"【pngSender】索引更新完成, 共发现 {len(PHOTO_CACHE)} 张照片")


@scheduler.scheduled_job("interval", weeks=1)
async def auto_refresh():
    scan_photos()


scan_photos()
get_png = on_command("来张美照", aliases={"看看美照"}, priority=5, block=True)

@get_png.handle()
async def handle_png(event: MessageEvent):

    # 1. 权限校验
    if event.user_id not in WHITELIST_QQ:
        await get_png.finish("哼，这张照片才不给你看呢！")

    # 2. 检查目录与缓存
    if not IMG_PATH.exists():
        await get_png.finish("错误：照片库路径不存在")

    # 3. 随机抽取
    target_photo = random.choice(PHOTO_CACHE)

    try:
        await get_png.send(MessageSegment.image(target_photo))
    except Exception as e:
        await get_png.finish("喵喵喵，照片跑丢了呢~")