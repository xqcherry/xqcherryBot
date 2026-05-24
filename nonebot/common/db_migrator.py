import re
import asyncio
from pathlib import Path
import aiosqlite
from nonebot import get_driver, logger

# 1. 动态计算默认的宿主机平级迁移目录
CURRENT_FILE = Path(__file__).resolve()
PROJECT_ROOT = CURRENT_FILE.parent.parent.parent
DEFAULT_MIGRATION_DIR = PROJECT_ROOT / "migrations"

async def run_flyway_migration():
    global_config = get_driver().config
    
    migration_dir_str = getattr(global_config, "db_migration_dir", None)
    MIGRATION_DIR = Path(migration_dir_str) if migration_dir_str else DEFAULT_MIGRATION_DIR
    
    db_path_str = getattr(global_config, "db_output_path", "/app/db/bot_data.db")
    DB_PATH = Path(db_path_str)

    logger.info(f"【Flyway】启动检查。正在扫描目录: {MIGRATION_DIR.resolve()}")
    
    if not MIGRATION_DIR.exists():
        logger.warning(f"【Flyway】未找到迁移脚本目录: {MIGRATION_DIR}，跳过迁移。")
        return

    # 匹配规则：以 V 开头，后面跟着至少一个数字，再跟着两个下划线
    pattern = re.compile(r"^V(\d+)__.*\.sql$")
    
    discovered_files = []
    for p in MIGRATION_DIR.glob("V*.sql"):
        match = pattern.match(p.name)
        if match:
            version_num = int(match.group(1))
            discovered_files.append((version_num, p))
            
    sql_files = sorted(discovered_files, key=lambda x: x[0])

    if not sql_files:
        logger.info("【Flyway】没有发现有效的 V*.sql 迁移脚本。")
        return

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    async with aiosqlite.connect(DB_PATH, isolation_level=None) as db:
        async with db.execute("PRAGMA user_version") as cursor:
            row = await cursor.fetchone()
            current_version = row[0] if row else 0

        logger.info(f"【Flyway】当前数据库版本: v{current_version}")

        for version, file_path in sql_files:
            if version > current_version:
                logger.info(f"【Flyway】正在执行数据库升级脚本: {file_path.name} (v{current_version} -> v{version})")
                try:
                    sql_content = file_path.read_text(encoding="utf-8-sig")
                    
                    await db.executescript(sql_content)
                    await db.execute(f"PRAGMA user_version = {version}")
                    
                    current_version = version
                except Exception as e:
                    logger.error(f"【Flyway】脚本 {file_path.name} 执行失败！终止后续迁移。错误: {e}")
                    return
                    
        logger.info(f"【Flyway】数据库版本检查完成。当前最新版本: v{current_version}")


try:
    loop = asyncio.get_running_loop()
    loop.create_task(run_flyway_migration())
except RuntimeError:
    get_driver().on_startup(run_flyway_migration)