# agent_bridge 解析

[agent_bridge/__init__.py](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/plugins/agent_bridge/__init__.py:1) 是真正的 NoneBot 插件接线层。

如果说 `adapter.py` 是“纯转换工具”，`tools.py` 是“NapCat 工具封装”，那么 `agent_bridge` 就是把这些东西接到 NoneBot 生命周期和消息事件上的地方。

**agent_bridge 总览**

这个文件做四件事：

1. 读取 agent gateway 相关环境变量。
2. 在 NoneBot 启动时创建并运行 WebSocket gateway 客户端。
3. 在 NoneBot 关闭时停止 gateway 客户端。
4. 监听 QQ 消息，把消息转发给 agent gateway。

它是实际运行时最关键的桥。

**导入部分**

文件开头：

```python
import asyncio
import os
from typing import Any

from nonebot import get_bot, get_driver, logger, on_message
from nonebot.adapters.onebot.v11 import Bot, MessageEvent

from adapter import (
    AgentConnection,
    GatewayWebSocketClient,
    gateway_message_from_event,
    handle_agent_event,
)
```

关键导入：

- `get_driver()`：注册启动/关闭生命周期事件。
- `on_message()`：注册普通消息 matcher。
- `get_bot()`：收到 agent gateway 事件时，拿当前 bot 发 QQ 消息。
- `Bot`, `MessageEvent`：OneBot v11 的 bot 和消息事件类型。
- `GatewayWebSocketClient`：连接 agent gateway。
- `gateway_message_from_event`：把 QQ 消息转成 gateway payload。
- `handle_agent_event`：把 gateway 返回事件转成 QQ 动作。

注意这里写的是：

```python
from adapter import ...
```

不是：

```python
from nonebot.adapter import ...
```

这说明运行时 Python 路径里应该把 `nonebot/adapter` 或相关目录放到了可直接导入 `adapter` 的位置。否则这个导入会和包路径有关，需要看启动方式。

**环境变量**

[环境变量定义](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/plugins/agent_bridge/__init__.py:15)：

```python
AGENT_GATEWAY_URL = os.getenv("AGENT_GATEWAY_URL", "ws://127.0.0.1:8787")
AGENT_AUTHOR_QQ = os.getenv("AGENT_AUTHOR_QQ", "")
AGENT_AUTO_PERMISSION = os.getenv("AGENT_AUTO_PERMISSION")
AGENT_TRIGGER_PREFIX = os.getenv("AGENT_TRIGGER_PREFIX", "#agent")
```

含义：

```text
AGENT_GATEWAY_URL       agent gateway WebSocket 地址，默认 ws://127.0.0.1:8787
AGENT_AUTHOR_QQ         权限请求和错误通知发给哪个 QQ
AGENT_AUTO_PERMISSION   自动权限决策，通常是 allow 或 deny
AGENT_TRIGGER_PREFIX    触发 agent 的消息前缀，默认 #agent
```

如果没有设置 `AGENT_AUTHOR_QQ`，权限请求和错误通知会尝试发给空字符串。这在实际部署里最好显式配置。

**全局状态**

[全局变量](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/plugins/agent_bridge/__init__.py:20)：

```python
gateway: GatewayWebSocketClient | None = None
gateway_task: asyncio.Task | None = None
```

这两个变量保存当前 gateway 客户端和后台任务。

- `gateway`：用于 `_send_to_gateway()` 发送消息。
- `gateway_task`：用于 shutdown 时 cancel。

它们在 startup 时赋值，在 shutdown 时停止。

**_event_brief**

[_event_brief](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/plugins/agent_bridge/__init__.py:24) 用来生成简短日志信息：

```python
def _event_brief(event: MessageEvent) -> dict[str, Any]:
    return {
        "message_type": getattr(event, "message_type", None),
        "group_id": str(getattr(event, "group_id", "")) or None,
        "user_id": str(getattr(event, "user_id", "")) or None,
        "message_id": str(getattr(event, "message_id", "")) or None,
        "raw_message": getattr(event, "raw_message", ""),
    }
```

它只在消息转换失败时用于日志：

```python
logger.warning(f"Failed to convert QQ event to agent payload: {_event_brief(event)} {error}")
```

这样日志里不会 dump 整个 NoneBot event，只保留关键字段。

**_is_supported_message**

[_is_supported_message](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/plugins/agent_bridge/__init__.py:35) 判断是否支持当前消息类型：

```python
message_type = getattr(event, "message_type", None)
return message_type in {"group", "private"}
```

只支持：

```text
group   群聊
private 私聊
```

其他 OneBot 事件不会进入 adapter 转换流程。

**_is_self_message**

[_is_self_message](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/plugins/agent_bridge/__init__.py:40) 判断消息是不是机器人自己发的：

```python
return str(getattr(event, "user_id", "")) == str(bot.self_id)
```

这是为了避免机器人自己的回复又被转发给 agent gateway，造成自我循环。

比如 agent 回复了一条群消息，如果这条消息又被 NoneBot 当普通消息收到，就应该跳过。

**_send_to_gateway**

[_send_to_gateway](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/plugins/agent_bridge/__init__.py:44) 是统一发送函数：

```python
async def _send_to_gateway(payload: dict[str, Any]) -> None:
    if gateway is None:
        logger.warning("Agent gateway client is not initialized")
        return

    try:
        await gateway.send_json(payload)
    except RuntimeError as error:
        logger.warning(f"Agent gateway is not connected: {error}")
    except Exception as error:
        logger.exception(f"Failed to send message to agent gateway: {error}")
```

它处理三种情况：

- `gateway is None`：客户端还没初始化。
- `RuntimeError`：通常是 WebSocket 还没连接上。
- 其他异常：记录完整异常栈。

这个函数是 QQ 消息转发到 agent gateway 的唯一出口。

**start_agent_gateway_client**

[start_agent_gateway_client](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/plugins/agent_bridge/__init__.py:56) 注册在 NoneBot startup：

```python
@get_driver().on_startup
async def start_agent_gateway_client() -> None:
```

启动时它做几件事。

第一步，定义内部回调 `on_agent_event`：

```python
async def on_agent_event(event: dict[str, Any]) -> None:
```

这个回调会被 `GatewayWebSocketClient.run_once()` 调用。gateway 每发来一个事件，都会进这里。

第二步，获取当前 bot：

```python
try:
    bot = get_bot()
except Exception as error:
    logger.warning(f"Cannot get NoneBot bot for agent event: {error}")
    return
```

如果拿不到 bot，就无法向 QQ 发送消息，所以直接返回。

第三步，创建 `AgentConnection`：

```python
connection = AgentConnection(
    send_json=lambda payload: asyncio.create_task(_send_to_gateway(payload))
)
```

这里的意思是：如果 `handle_agent_event()` 需要向 gateway 回发消息，比如权限响应，就通过 `_send_to_gateway()` 发。

因为 `AgentConnection.send_json()` 是同步包装函数，所以这里用 `asyncio.create_task(...)` 把 async 发送任务丢到事件循环里。

第四步，处理 agent event：

```python
await handle_agent_event(
    bot,
    connection,
    event,
    authorizer_id=AGENT_AUTHOR_QQ,
    auto_decision=AGENT_AUTO_PERMISSION,
)
```

这里把真正的业务交给 `adapter.py`。

`agent_bridge` 不关心 event 类型细节，只负责提供 bot、connection 和配置。

第五步，创建 gateway 客户端：

```python
gateway = GatewayWebSocketClient(
    AGENT_GATEWAY_URL,
    on_event=on_agent_event,
    retry_seconds=3,
)
```

第六步，后台运行：

```python
gateway_task = asyncio.create_task(gateway.run_forever())
```

所以 WebSocket 客户端不会阻塞 NoneBot 启动，而是在后台一直连接和重连。

最后记录日志：

```python
logger.info(f"Agent gateway client started: {AGENT_GATEWAY_URL}")
```

**stop_agent_gateway_client**

[stop_agent_gateway_client](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/plugins/agent_bridge/__init__.py:93) 注册在 NoneBot shutdown：

```python
@get_driver().on_shutdown
async def stop_agent_gateway_client() -> None:
```

关闭流程：

```python
if gateway is not None:
    gateway.stop()
```

先告诉客户端停止重连循环。

然后取消后台任务：

```python
if gateway_task is not None:
    gateway_task.cancel()
    try:
        await gateway_task
    except asyncio.CancelledError:
        pass
```

这里正确处理了 `CancelledError`，避免 shutdown 时把正常取消当异常。

最后打日志：

```python
logger.info("Agent gateway client stopped")
```

**agent_message matcher**

[agent_message](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/plugins/agent_bridge/__init__.py:109)：

```python
agent_message = on_message(priority=50, block=False)
```

含义：

- 监听普通消息。
- 优先级 50。
- `block=False`，不会阻止其他插件继续处理这条消息。

这很重要：agent bridge 是旁路监听，不会独占消息处理。

比如用户发普通命令，其他插件仍然可以响应；agent bridge 同时把消息作为 observed context 发给 gateway。

**handle_qq_message**

[handle_qq_message](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/plugins/agent_bridge/__init__.py:113) 是消息处理入口：

```python
@agent_message.handle()
async def handle_qq_message(bot: Bot, event: MessageEvent) -> None:
```

第一步，过滤不支持的消息：

```python
if not _is_supported_message(event):
    return
```

只保留群聊和私聊。

第二步，过滤自己发的消息：

```python
if _is_self_message(bot, event):
    return
```

避免机器人回复进入循环。

第三步，转换 payload：

```python
payload = gateway_message_from_event(
    event,
    trigger_prefix=AGENT_TRIGGER_PREFIX,
)
```

这里会根据消息是否以 `#agent` 开头，决定生成：

```text
user_message      触发 agent 回复
observed_message  只记录上下文
```

如果转换失败，会记录 warning：

```python
logger.warning(f"Failed to convert QQ event to agent payload: {_event_brief(event)} {error}")
```

第四步，发给 gateway：

```python
await _send_to_gateway(payload)
```

第五步，按 payload 类型记录日志：

```python
if payload["type"] == "user_message":
    logger.info(...)
else:
    logger.debug(...)
```

触发 agent 的消息用 info；普通旁听消息用 debug。

**实际运行链路**

从 QQ 消息进入到 gateway：

```text
QQ/NapCat
  -> NoneBot MessageEvent
  -> agent_message matcher
  -> handle_qq_message
  -> _is_supported_message
  -> _is_self_message
  -> gateway_message_from_event
  -> _send_to_gateway
  -> GatewayWebSocketClient.send_json
  -> agent gateway
```

从 gateway 回到 QQ：

```text
agent gateway
  -> GatewayWebSocketClient.run_once 收到 JSON
  -> on_agent_event
  -> get_bot
  -> AgentConnection
  -> handle_agent_event
  -> bot.send_group_msg / bot.send_private_msg
  -> QQ/NapCat
```

**和 adapter.py 的分工**

`agent_bridge` 和 `adapter.py` 的关系很清楚：

```text
agent_bridge:
  负责 NoneBot 生命周期、matcher、日志、全局 gateway 任务。

adapter.py:
  负责消息格式转换、agent 事件处理、WebSocket 客户端。
```

这样 `adapter.py` 不需要 import NoneBot，也不需要知道插件注册细节。

**我看到的几个设计点**

- `block=False` 让它成为旁路监听，不影响现有插件。
- `_is_self_message()` 避免机器人回复循环。
- `on_startup` 和 `on_shutdown` 正确管理后台任务。
- `_send_to_gateway()` 对连接未就绪做了容错，不会因为 gateway 没连上导致消息 handler 崩掉。
- `AGENT_AUTHOR_QQ` 默认空字符串，部署时最好显式配置。
- `from adapter import ...` 依赖运行时 import path，后续如果包结构调整，这里可能是一个容易踩坑的点。
- `GatewayWebSocketClient.run_forever()` 内部吞异常，`agent_bridge` 只能看到启动日志；如果需要排查 gateway 连接问题，最好在客户端重连异常处加日志。
