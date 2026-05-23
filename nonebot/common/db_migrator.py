import re
from pathlib import Path
import aiosqlite
from nonebot import get_driver, logger

global_config = get_driver().config
MIGRATION_DIR = Path(getattr(global_config, "db_migration_dir", "/app/nonebot/migrations"))
DB_PATH = Path(getattr(global_config, "db_output_path", "/app/db/bot_data.db"))

@get_driver().on_startup
async def run_flyway_migration():
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
            
    # 严格按照版本号从小到大排序
    sql_files = sorted(discovered_files, key=lambda x: x[0])

    if not sql_files:
        logger.info("【Flyway】没有发现有效的 V*.sql 迁移脚本。")
        return

    # 确保数据库父级目录存在
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)

    async with aiosqlite.connect(DB_PATH) as db:
        # 2. 获取当前数据库的内部版本号
        async with db.execute("PRAGMA user_version") as cursor:
            row = await cursor.fetchone()
            current_version = row[0] if row else 0

        # 3. 增量执行尚未运行的更高版本脚本
        for version, file_path in sql_files:
            if version > current_version:
                logger.info(f"【Flyway】正在执行数据库升级脚本: {file_path.name} (v{current_version} -> v{version})")
                try:
                    sql_content = file_path.read_text(encoding="utf-8")
                    
                    await db.executescript(sql_content)
                    await db.execute(f"PRAGMA user_version = {version}")
                    await db.commit()
                    
                    current_version = version
                except Exception as e:
                    logger.error(f"【Flyway】脚本 {file_path.name} 执行失败！终止后续迁移。错误: {e}")
                    return
                    
        logger.info(f"【Flyway】数据库版本检查完成。当前最新版本: v{current_version}")