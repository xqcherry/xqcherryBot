import json
import os
import threading
from pathlib import Path
from typing import Any, Dict, Optional, Tuple, Union
from nonebot import logger

class JsonUtils:
    """
    支持：多线程文件锁、自动创建路径、增量补全默认配置
    的 JSON 文件操作工具
    """

    _file_locks: Dict[str, threading.RLock] = {}
    _global_lock = threading.RLock()
    BASE_DATA_DIR = Path("data/plugins")

    @classmethod
    def _get_file_lock(cls, file_path: str) -> threading.RLock:
        with cls._global_lock:
            if file_path not in cls._file_locks:
                cls._file_locks[file_path] = threading.RLock()
            return cls._file_locks[file_path]
    
    @classmethod
    def _get_full_path(cls, filename: str) -> str:
        """解析相对路径为绝对路径"""
        full_path = cls.BASE_DATA_DIR / filename
        full_path.parent.mkdir(parents=True, exist_ok=True)
        return str(full_path.absolute())

    @classmethod
    def read(cls, filename: str, default: Optional[dict] = None) -> Tuple[Any, bool]:
        """
        读取 JSON 文件
        :param filename: 相对路径
        :param default: 默认内容
        :return: (数据内容, 是否为新创建的文件)
        """
        file_path = cls._get_full_path(filename)
        lock = cls._get_file_lock(file_path)

        with lock:
            if not os.path.exists(file_path):
                default = default or {}
                cls.write(filename, default)
                return default, True

            try:
                with open(file_path, "r", encoding="utf-8") as f:
                    content = json.load(f)

                if isinstance(content, dict) and isinstance(default, dict):
                    changed = False
                    for k, v in default.items():
                        if k not in content:
                            content[k] = v
                            changed = True
                    if changed:
                        cls.write(filename, content)
                return content, False
            except Exception as e:
                logger.error(f"读取文件 {filename} 出错: {e}")
                return default or {}, False
        
    @classmethod
    def write(cls, filename: str, content: Any) -> bool:
        """安全写入 JSON 文件"""
        file_path = cls._get_full_path(filename)
        lock = cls._get_file_lock(file_path)

        with lock:
            try:
                with open(file_path, "w", encoding="utf-8") as f:
                    json.dump(content, f, indent=4, ensure_ascii=False)
                return True
            except Exception as e:
                logger.error(f"写入文件 {filename} 失败: {e}")
                return False

    @classmethod
    def update(cls, filename: str, updates: Dict[str, Any]) -> bool:
        """增量更新字典格式的 JSON"""
        file_path = cls._get_full_path(filename)
        lock = cls._get_file_lock(file_path)

        with lock:
            data, _ = cls.read(filename)
            if isinstance(data, dict):
                data.update(updates)
                return cls.write(filename, data)
            return False