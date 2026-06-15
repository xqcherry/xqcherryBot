# tools.py 解析

[tools.py](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/adapter/tools.py:1) 的作用是把 NapCat/OneBot bot API 包装成 agent 可调用的工具层。

它不负责连接 gateway，也不负责接收 QQ 消息。它只解决一个问题：agent 要读群资料、读用户资料、发消息、引用回复时，应该怎么调用当前 NoneBot 的 `bot` 对象。

**tools.py 总览**

这个文件主要有三部分：

1. `ToolDescriptor`：描述工具的名字、说明、是否只读。
2. `NapCatTools`：工具注册表和调用入口。
3. `_target_from()`：从输入参数和上下文里推断目标群聊/私聊。

**ToolDescriptor**

[ToolDescriptor](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/adapter/tools.py:5) 是一个冻结的 dataclass：

```python
@dataclass(frozen=True)
class ToolDescriptor:
    name: str
    description: str
    read_only: bool
```

字段含义：

- `name`：工具名，比如 `send_message`
- `description`：给 agent 或工具注册层看的描述
- `read_only`：是否只读

`read_only=True` 的工具理论上不改变外部状态，比如查消息、查群资料。`read_only=False` 的工具会产生副作用，比如发消息。

这里 `frozen=True` 表示实例创建后不能改字段，适合做工具元数据。

**NapCatTools 初始化**

[NapCatTools](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/adapter/tools.py:11) 初始化时接收一个 `bot`：

```python
class NapCatTools:
    def __init__(self, bot):
        self.bot = bot
        self._tools = {
            ...
        }
```

这个 `bot` 就是 NoneBot OneBot v11 的 `Bot` 对象。后面所有工具调用最终都会落到这个 `bot` 上。

它注册了 5 个工具：

```text
get_recent_messages  读取当前聊天的最近消息，只读
get_group_info       读取当前群资料，只读
get_user_info        读取用户资料，只读
send_message         发送群聊或私聊消息，非只读
reply_message        引用回复某条消息，非只读
```

对应代码里的 `_tools` 字典。

**get_tool**

[get_tool](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/adapter/tools.py:29) 很直接：

```python
def get_tool(self, name):
    return self._tools[name]
```

传入工具名，返回对应的 `ToolDescriptor`。

如果工具名不存在，会抛 `KeyError`。这里没有做友好错误处理，说明它更偏内部调用。

**call**

[call](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/adapter/tools.py:32) 是工具统一入口：

```python
async def call(self, name, input_data, context=None):
    context = context or {}
    if name == "get_recent_messages":
        return await self._get_recent_messages(input_data, context)
    ...
    raise KeyError(name)
```

参数含义：

- `name`：工具名
- `input_data`：agent 传进来的工具参数
- `context`：当前消息上下文，通常包含 metadata

它根据 `name` 分发到具体私有方法。

目前是手写 `if` 分发。工具数量少时没问题；如果以后工具变多，可以考虑用映射表，但现在这样足够清楚。

**_get_recent_messages**

[_get_recent_messages](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/adapter/tools.py:45) 读取当前群聊最近消息：

```python
target = _target_from(input_data, context)
limit = int(input_data.get("limit", 20))
if target["messageType"] != "group":
    return {"messages": []}
return await self.bot.get_group_msg_history(
    group_id=str(target["groupId"]),
    count=limit,
)
```

关键点：

- 默认读取 20 条。
- 只支持群聊。
- 如果当前目标不是群聊，直接返回空消息列表。
- 群聊时调用 `bot.get_group_msg_history()`。

所以私聊里调用这个工具不会报错，而是返回：

```python
{"messages": []}
```

这是一种保守处理，避免 agent 在私聊上下文里调用群历史接口失败。

**_get_group_info**

[_get_group_info](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/adapter/tools.py:57) 读取群资料：

```python
target = _target_from(input_data, context)
group_id = input_data.get("groupId") or target.get("groupId")
return await self.bot.get_group_info(group_id=str(group_id))
```

优先使用工具输入里的 `groupId`。如果没传，就从当前上下文推断。

最终调用 OneBot API：

```python
bot.get_group_info(group_id=...)
```

如果既没有显式 `groupId`，上下文也没有 `groupId`，这里会把 `None` 转成字符串 `"None"` 发给 API。这个是潜在风险点：缺参数时错误不够早、不够清晰。

**_get_user_info**

[_get_user_info](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/adapter/tools.py:62) 读取用户资料：

```python
target = _target_from(input_data, context)
user_id = input_data.get("userId") or target.get("userId")
return await self.bot.get_stranger_info(user_id=str(user_id))
```

优先使用 `input_data["userId"]`，没有就从当前上下文 metadata 取。

调用的是：

```python
bot.get_stranger_info(user_id=...)
```

名字叫 stranger info，但 OneBot/NapCat 通常用它查询用户基础资料。

同样，如果没有用户 ID，可能会把 `"None"` 传下去。

**_send_message**

[_send_message](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/adapter/tools.py:67) 发送消息：

```python
target = _target_from(input_data, context)
text = input_data["text"]
if target["messageType"] == "group":
    return await self.bot.send_group_msg(
        group_id=str(target["groupId"]), message=text
    )
return await self.bot.send_private_msg(user_id=str(target["userId"]), message=text)
```

关键点：

- `text` 是必填字段，用 `input_data["text"]` 取；缺失会直接 `KeyError`。
- 如果目标是群聊，调用 `send_group_msg`。
- 其他情况默认走私聊 `send_private_msg`。

这里的默认分支比较宽：只要 `messageType` 不是 `"group"`，就会按私聊发送。理论上如果 `messageType` 缺失，可能会尝试给 `userId=None` 发私聊。这个也是潜在风险点。

**_reply_message**

[_reply_message](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/adapter/tools.py:76) 引用回复消息：

```python
target = _target_from(input_data, context)
text = input_data["text"]
message_id = input_data.get("messageId") or target["messageId"]
reply_text = f"[CQ:reply,id={message_id}]{text}"
```

它用 CQ 码构造引用回复：

```text
[CQ:reply,id={message_id}]回复内容
```

然后和 `_send_message` 类似：

- 群聊：`send_group_msg`
- 其他：`send_private_msg`

这里 `messageId` 可以显式传，也可以从当前上下文 metadata 里拿。

如果 `messageId` 不存在，`target["messageId"]` 可能是 `None`，最终会生成：

```text
[CQ:reply,id=None]...
```

这也是一个参数校验上的潜在风险。

**_target_from**

[_target_from](//wsl.localhost/Ubuntu/home/xqcherry/repository/bot/nonebot/adapter/tools.py:94) 是这个文件最关键的辅助函数。它负责决定工具要作用在哪个聊天目标上。

先取上下文：

```python
metadata = context.get("metadata", {})
```

如果 `input_data` 里有 `chat`：

```python
if "chat" in input_data:
    chat = input_data["chat"]
    message_type = chat.get("type")
    return {
        "messageType": message_type,
        "groupId": chat.get("groupId"),
        "userId": chat.get("userId"),
        "messageId": input_data.get("messageId") or metadata.get("messageId"),
    }
```

这表示 agent 可以显式指定目标聊天：

```python
{
    "chat": {
        "type": "group",
        "groupId": "123456"
    },
    "text": "hello"
}
```

如果没有 `chat`，则从显式字段或上下文 metadata 取：

```python
return {
    "messageType": input_data.get("messageType") or metadata.get("messageType"),
    "groupId": input_data.get("groupId") or metadata.get("groupId"),
    "userId": input_data.get("userId") or metadata.get("userId"),
    "messageId": input_data.get("messageId") or metadata.get("messageId"),
}
```

优先级是：

```text
input_data 显式字段 > context.metadata
```

也就是说，默认情况下工具会作用在“触发 agent 的那条消息所在会话”；但 agent 也可以显式指定别的群或用户。

**tools.py 的实际角色**

完整链路里，`tools.py` 位于 agent 主动操作 QQ 的一侧：

```text
agent 想调用工具
  -> 工具名 + input_data + context
  -> NapCatTools.call(...)
  -> _target_from 推断目标
  -> bot.get_group_info / bot.send_group_msg / ...
  -> NapCat/OneBot 执行
```

这和 `adapter.py` 的职责不同：

- `adapter.py` 管消息进出 gateway。
- `tools.py` 管 agent 调用 QQ 能力。

**我看到的几个设计点**

- 工具描述和工具执行放在一个类里，结构简单。
- `read_only` 字段为权限控制留下了空间。
- `_target_from()` 支持显式目标和上下文目标，适合 agent 工具调用。
- 参数校验比较少，缺失 `groupId`、`userId`、`messageId` 时可能把 `"None"` 传给 NapCat。
- `_send_message()` 对非 group 默认按 private 处理，未来如果支持更多 messageType，最好显式判断。
- 当前 `NapCatTools` 在项目里没有直接被 `agent_bridge` 引用，可能是给 agent gateway 或后续工具注册流程预留的。
