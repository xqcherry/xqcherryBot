from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Iterable

HIDDEN_PLUGIN_MODULES = {
    "nonebot.plugins.echo",
}

HIDDEN_PLUGIN_NAMES = {
    "echo",
}

HELP_MENU_CACHE_VERSION = 1


def _metadata_extra(metadata: Any) -> dict[str, Any]:
    extra = getattr(metadata, "extra", None)
    return extra if isinstance(extra, dict) else {}


def _module_fallback_name(plugin: Any) -> str:
    module_name = getattr(plugin, "module_name", "") or getattr(plugin, "name", "")
    return str(module_name).rsplit(".", 1)[-1] or "未命名插件"


def _plugin_module_name(plugin: Any) -> str:
    return str(getattr(plugin, "module_name", "") or getattr(plugin, "name", ""))


def collect_plugin_help(plugins: Iterable[Any]) -> list[dict[str, Any]]:
    help_items: list[dict[str, Any]] = []

    for plugin in plugins:
        metadata = getattr(plugin, "metadata", None)
        if metadata is None:
            continue

        extra = _metadata_extra(metadata)
        if extra.get("hidden") is True:
            continue

        name = getattr(metadata, "name", None) or _module_fallback_name(plugin)
        module_name = _plugin_module_name(plugin)
        if module_name in HIDDEN_PLUGIN_MODULES or str(name) in HIDDEN_PLUGIN_NAMES:
            continue

        description = getattr(metadata, "description", None) or "暂无描述"
        usage = getattr(metadata, "usage", None) or "暂无用法说明"
        order = extra.get("help_order", 1000)

        help_items.append(
            {
                "name": str(name),
                "description": str(description),
                "usage": str(usage),
                "order": int(order) if isinstance(order, int) or str(order).isdigit() else 1000,
            }
        )

    return sorted(help_items, key=lambda item: (item["order"], item["name"]))


def find_plugin_help(plugins: Iterable[Any], plugin_name: str) -> dict[str, Any] | None:
    target_name = plugin_name.strip()
    if not target_name:
        return None

    for item in collect_plugin_help(plugins):
        if item["name"] == target_name:
            return item
    return None


def format_plugin_detail(item: dict[str, Any]) -> str:
    return f"【{item['name']}】\n描述：{item['description']}\n\n用法：\n{item['usage']}"


def format_plugin_not_found(plugin_name: str, plugins: Iterable[Any]) -> str:
    names = [item["name"] for item in collect_plugin_help(plugins)]
    available = "、".join(names) if names else "暂无可用插件"
    return f"未找到插件：{plugin_name}\n可用插件：{available}"


def build_help_menu_cache_signature(items: list[dict[str, Any]], template_mtime_ns: int) -> str:
    payload = {
        "version": HELP_MENU_CACHE_VERSION,
        "template_mtime_ns": template_mtime_ns,
        "plugins": [
            {
                "name": item["name"],
                "description": item["description"],
                "usage": item["usage"],
                "order": item["order"],
            }
            for item in items
        ],
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def read_cached_help_image(image_path: Path, meta_path: Path, signature: str) -> bytes | None:
    try:
        if not image_path.exists() or not meta_path.exists():
            return None
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        if meta.get("signature") != signature:
            return None
        return image_path.read_bytes()
    except (OSError, json.JSONDecodeError):
        return None


def write_cached_help_image(image_path: Path, meta_path: Path, img_bytes: bytes, signature: str) -> None:
    image_path.parent.mkdir(parents=True, exist_ok=True)
    image_path.write_bytes(img_bytes)
    meta_path.write_text(
        json.dumps({"signature": signature}, ensure_ascii=False, sort_keys=True),
        encoding="utf-8",
    )
