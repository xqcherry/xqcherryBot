# adapter.py 解析

**adapter.py 总览**

[adapter.py](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/adapter/adapter.py:1) 做三件事：

1. 把 NoneBot/OneBot 的 QQ 事件转成 agent gateway 的消息格式。
2. 把 agent gateway 返回的事件转成 QQ 发送动作。
3. 维护一个 WebSocket 客户端，连接独立 agent gateway。

它本身不依赖 NoneBot 类型，很多地方只假设 `event` 可以通过 dict 或属性取值。这是为了方便单元测试和复用。

**AgentConnection**

[AgentConnection](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/adapter/adapter.py:6) 很薄：

```python
class AgentConnection:
    def __init__(self, send_json):
        self._send_json = send_json

    def send_json(self, payload):
        result = self._send_json(payload)
        return result
```

作用是包装一个 `send_json` 函数，给 `handle_agent_event()` 用。比如 agent 请求权限时，`handle_agent_event()` 需要往 gateway 发 `permission_response`，但它不关心底层 WebSocket 是什么，只调用 `connection.send_json(...)`。

实际在 [agent_bridge](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/plugins/agent_bridge/__init__.py:67) 里是这样接的：用 `asyncio.create_task(_send_to_gateway(payload))` 包成 connection。

**session_id_from_event**

[session_id_from_event](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/adapter/adapter.py:15) 把 QQ 会话变成统一 session id：

```text
群聊   group   -> qq-group:{group_id}
私聊   private -> qq-user:{user_id}
```

这个 session id 是 agent 侧识别上下文的关键。群聊和私聊不能混在一起，所以这里显式加了前缀。

如果 `message_type` 不是 `group` 或 `private`，会直接 `raise ValueError`。外层 `agent_bridge` 已经先用 `_is_supported_message()` 过滤了一次。

**observed_message_from_event**

[observed_message_from_event](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/adapter/adapter.py:37) 把 QQ 消息转成“旁听消息”。

生成的数据结构大概是：

```python
{
    "type": "observed_message",
    "sessionId": "qq-group:123456",
    "messageId": "789",
    "senderId": "10001",
    "text": "原始消息文本",
    "timestamp": "2026-05-28T...",
    "metadata": {
        "platform": "qq",
        "adapter": "nonebot-napcat",
        "messageType": "group",
        "userId": "10001",
        "messageId": "789",
        "groupId": "123456",
    },
}
```

`observed_message` 的含义是：这条消息给 agent 记录上下文，但不一定触发 agent 回复。

比如群里有人聊天，没有 `#agent` 前缀，也会被转发给 gateway 当上下文。

**user_message_from_event**

[user_message_from_event](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/adapter/adapter.py:24) 基于 `observed_message_from_event()` 再改几个字段：

```python
message.update(
    {
        "type": "user_message",
        "rawText": raw_text,
        "text": strip_agent_prefix(raw_text),
    }
)
```

区别是：

- `type` 从 `observed_message` 改成 `user_message`
- `rawText` 保存原始文本，比如 `#agent 帮我总结`
- `text` 保存去掉触发前缀后的文本，比如 `帮我总结`

`user_message` 的含义是：这条消息明确触发 agent 处理，应该产生一轮 agent 回复。

**gateway_message_from_event**

[gateway_message_from_event](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/adapter/adapter.py:63) 是入口判断函数：

```python
raw_text = _get(event, "raw_message")
if isinstance(raw_text, str) and raw_text.startswith(trigger_prefix):
    return user_message_from_event(event)
return observed_message_from_event(event)
```

默认触发前缀是 `#agent`。

所以：

```text
#agent 你好       -> user_message
普通聊天内容       -> observed_message
```

这个函数被 [agent_bridge.handle_qq_message](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/plugins/agent_bridge/__init__.py:121) 调用。

**handle_agent_event**

[handle_agent_event](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/adapter/adapter.py:70) 处理 agent gateway 发回来的事件。

它认识几种 `event["type"]`：

```text
assistant_delta
final_result
permission_request
error
```

`assistant_delta`：

```python
if event_type == "assistant_delta":
    return None
```

现在直接忽略。一般 delta 是流式输出片段，但 QQ 这边没有做流式展示，所以不处理。

`final_result`：

```python
if event_type == "final_result":
    result = event.get("result", "")
    session_id = event.get("sessionId", "")
```

这是 agent 最终回复。发送目标判断优先看 `sessionId`：

```text
qq-group:{id} -> bot.send_group_msg
qq-user:{id}  -> bot.send_private_msg
```

如果 `sessionId` 不完整，再 fallback 到 metadata：

```text
metadata.messageType == group   -> send_group_msg
metadata.messageType == private -> send_private_msg
```

所以 agent 返回：

```python
{
    "type": "final_result",
    "sessionId": "qq-group:123456",
    "result": "这是回复"
}
```

最终会调用：

```python
await bot.send_group_msg(group_id="123456", message="这是回复")
```

`permission_request`：

agent 想调用有风险工具时，会发权限请求。这里会私聊 `authorizer_id`：

```text
[agent permission] {riskSummary 或 toolName}
```

如果 `auto_decision` 是 `allow` 或 `deny`，它会自动回 gateway：

```python
{
    "type": "permission_response",
    "sessionId": event["sessionId"],
    "toolCallId": event["toolCallId"],
    "decision": auto_decision,
    "responderId": str(authorizer_id),
}
```

这个对应环境变量 `AGENT_AUTO_PERMISSION`。

`error`：

agent gateway 返回错误时，私聊授权人：

```text
[agent error] unknown error
```

**strip_agent_prefix**

[strip_agent_prefix](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/adapter/adapter.py:125) 负责去掉触发前缀：

```python
if text.startswith(prefix):
    return text[len(prefix):].lstrip()
```

例子：

```text
"#agent hello" -> "hello"
"#agent   hello" -> "hello"
"hello" -> "hello"
非字符串 -> ""
```

注意它只判断开头，不支持前面有空格的情况：

```text
" #agent hello" 不会触发
```

**timestamp_from_event**

[timestamp_from_event](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/adapter/adapter.py:133) 从事件的 `time` 字段取 Unix timestamp，然后转 UTC ISO 字符串。

如果 event 没有 `time`，返回 `None`。

比如 OneBot 的 `time=1710000000` 会变成类似：

```text
2024-03-09T16:00:00+00:00
```

**GatewayWebSocketClient**

[GatewayWebSocketClient](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/adapter/adapter.py:141) 是连接 agent gateway 的 WebSocket 客户端。

初始化参数：

```python
GatewayWebSocketClient(
    url,
    on_event,
    retry_seconds=3,
    connector=None,
)
```

字段含义：

- `url`：gateway 地址，比如 `ws://127.0.0.1:8787`
- `on_event`：收到 gateway 事件后调用的回调
- `retry_seconds`：断线后几秒重连
- `connector`：可注入的 websocket 连接器，方便测试

`send_json()`：

```python
if self._socket is None:
    raise RuntimeError("Gateway websocket is not connected")
await self._socket.send(json.dumps(payload, ensure_ascii=False))
```

如果还没连上，直接报错。外层 `agent_bridge._send_to_gateway()` 会捕获这个错误并打 warning。

`run_once()`：

```python
connector = self._connector or await _default_websocket_connector()
async with await connector(self.url) as socket:
    self._socket = socket
    async for raw_event in socket:
        event = json.loads(raw_event)
        result = self.on_event(event)
        if hasattr(result, "__await__"):
            await result
```

逻辑是：

1. 连接 WebSocket。
2. 保存 socket 到 `self._socket`，供 `send_json()` 使用。
3. 不断接收 gateway 发来的 JSON 字符串。
4. 解析成 dict。
5. 调用 `on_event(event)`。
6. 如果回调是 async，就 await。

`run_forever()`：

```python
while not self._stopped.is_set():
    try:
        await self.run_once()
    except Exception:
        await asyncio.sleep(self.retry_seconds)
```

任何异常都会吞掉，然后 sleep 重连。这个设计简单，但调试时有个缺点：这里不记录异常细节。如果 gateway 一直连不上，只能从外层日志或行为判断。

`stop()`：

```python
self._stopped.set()
```

只设置停止标志。真正 task cancel 是 `agent_bridge` 里做的。

**_default_websocket_connector**

[_default_websocket_connector](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/adapter/adapter.py:175) 动态 import `websockets`：

```python
import websockets
return websockets.connect
```

如果没装 `websockets`，会抛：

```text
GatewayWebSocketClient requires the optional 'websockets' package
```

这样 `adapter.py` 本身可以被导入，但只有真的用 WebSocket 时才要求依赖。

**_get**

[_get](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/adapter/adapter.py:185) 是兼容 dict 和对象的取值函数：

```python
if isinstance(event, dict):
    return event[key]
return getattr(event, key)
```

所以 adapter 可以处理两种输入：

```python
event["message_type"]
event.message_type
```

NoneBot 的 `MessageEvent` 通常是对象；测试里可以直接用 dict。

**实际运行链路**

和 `agent_bridge` 连起来看，完整链路是：

```text
QQ/NapCat
  -> NoneBot MessageEvent
  -> agent_bridge.handle_qq_message
  -> adapter.gateway_message_from_event
  -> GatewayWebSocketClient.send_json
  -> agent gateway
  -> GatewayWebSocketClient.run_once 收到 final_result
  -> adapter.handle_agent_event
  -> bot.send_group_msg / bot.send_private_msg
  -> QQ/NapCat
```

**我看到的几个设计点**

- `adapter.py` 是纯转换/传输层，不直接注册 NoneBot 插件，这样比较好测。
- `observed_message` 和 `user_message` 分得很清楚：一个用于上下文，一个用于触发 agent。
- `sessionId` 设计简单稳定，`qq-group:` / `qq-user:` 很容易反向解析。
- `handle_agent_event()` 现在只支持最终结果，不展示流式 `assistant_delta`。
- `run_forever()` 吞异常重连，但没有日志，排查连接问题时可能不够直观。
- `plugin.py` 当前没有实际插件行为，确实像遗留/预留文件。
