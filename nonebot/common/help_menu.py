from __future__ import annotations

from typing import Any, Iterable


DEFAULT_HELP_ORDER = {
    "日程提醒": 30,
    "QQ点赞": 20,
    "需求管理": 30,
    "pngSender": 40,
    "随机获取猪猪图片": 50,
}


def _metadata_extra(metadata: Any) -> dict[str, Any]:
    extra = getattr(metadata, "extra", None)
    return extra if isinstance(extra, dict) else {}


def _module_fallback_name(plugin: Any) -> str:
    module_name = getattr(plugin, "module_name", "") or getattr(plugin, "name", "")
    return str(module_name).rsplit(".", 1)[-1] or "未命名插件"


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
        description = getattr(metadata, "description", None) or "暂无描述"
        usage = getattr(metadata, "usage", None) or "暂无用法说明"
        order = extra.get("help_order", DEFAULT_HELP_ORDER.get(name, 1000))

        help_items.append(
            {
                "name": str(name),
                "description": str(description),
                "usage": str(usage),
                "order": int(order) if isinstance(order, int) or str(order).isdigit() else 1000,
            }
        )

    return sorted(help_items, key=lambda item: (item["order"], item["name"]))
