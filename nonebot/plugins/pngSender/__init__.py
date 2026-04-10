import random
from pathlib import Path
from nonebot import on_command
from nonebot.adapters.onebot.v11 import MessageSegment, MessageEvent
from nonebot.plugin import PluginMetadata

__plugin_meta__ = PluginMetadata(
    name="pngSender",
    description="从 本地库 随机抽取照片发送",
    usage="指令：来张美照 / 看看美照",
    config=None,
)

IMG_PATH = Path(/app/photos) 
WHITELIST_QQ = {2417185282, 2683361634, 2303866129}
VALID_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
PHOTO_CACHE = [
    f for f in IMG_PATH.iterdir() 
    if f.is_file() and f.suffix.lower() in VALID_EXTENSIONS
] if IMG_PATH.exists() else []

get_png = on_command("来张美照", aliases={"看看美照"}, priority=5, block=True)

@get_png.handle()
async def handle_png(event: MessageEvent):

    # 1. 权限校验
    if event.user_id not in WHITELIST_QQ:
        await get_png.finish("哼，这张照片才不给你看呢！")

    # 2. 检查目录与缓存
    if not IMG_PATH.exists():
        await get_png.finish("错误：照片库路径不存在")

    if not PHOTO_CACHE:
        await get_png.finish("照片库空空如也，或者路径配置错误~")

    # 3. 随机抽取
    target_photo = random.choice(PHOTO_CACHE)

    try:
        file_path = f"file:///{target_photo.absolute()}"
        await get_png.send(MessageSegment.image(file_path))
    except Exception as e:
        print(f"Error sending image: {e}")
        await get_png.finish("喵喵喵，照片跑丢了呢~")