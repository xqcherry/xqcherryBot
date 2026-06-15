from dataclasses import dataclass


@dataclass(frozen=True)
class ToolDescriptor:
    name: str
    description: str
    read_only: bool


class NapCatTools:
    def __init__(self, bot):
        self.bot = bot
        self._tools = {
            "get_recent_messages": ToolDescriptor(
                "get_recent_messages", "Read recent messages from the current chat.", True,
            ),
            "get_group_info": ToolDescriptor(
                "get_group_info", "Read current group profile information.", True
            ),
            "get_user_info": ToolDescriptor(
                "get_user_info", "Read user profile information.", True
            ),
            "send_message": ToolDescriptor(
                "send_message", "Send a message to a group or private chat.", False
            ),
            "reply_message": ToolDescriptor(
                "reply_message", "Reply to a specific message.", False
            ),
        }

    def get_tool(self, name):
        return self._tools[name]

    async def call(self, name, input_data, context=None):
        context = context or {}
        if name == "get_recent_messages":
            return await self._get_recent_messages(input_data, context)
        if name == "get_group_info":
            return await self._get_group_info(input_data, context)
        if name == "get_user_info":
            return await self._get_user_info(input_data, context)
        if name == "send_message":
            return await self._send_message(input_data, context)
        if name == "reply_message":
            return await self._reply_message(input_data, context)
        raise KeyError(name)

    async def _get_recent_messages(self, input_data, context):
        target = _target_from(input_data, context)
        limit = int(input_data.get("limit", 20))
        _require_message_type(target)
        if target["messageType"] != "group":
            return {"messages": []}
        return await self.bot.get_group_msg_history(
            group_id=str(target["groupId"]),
            count=limit,
        )

    async def _get_group_info(self, input_data, context):
        target = _target_from(input_data, context)
        group_id = input_data.get("groupId") or target.get("groupId")
        _require_non_empty(group_id, "groupId")
        return await self.bot.get_group_info(group_id=str(group_id))

    async def _get_user_info(self, input_data, context):
        target = _target_from(input_data, context)
        user_id = input_data.get("userId") or target.get("userId")
        _require_non_empty(user_id, "userId")
        return await self.bot.get_stranger_info(user_id=str(user_id))

    async def _send_message(self, input_data, context):
        target = _target_from(input_data, context)
        text = _require_non_empty(input_data.get("text"), "text")
        message_type = _require_message_type(target)
        if target["messageType"] == "group":
            _require_non_empty(target.get("groupId"), "groupId")
            return await self.bot.send_group_msg(
                group_id=str(target["groupId"]), message=text
            )
        _require_non_empty(target.get("userId"), "userId")
        return await self.bot.send_private_msg(user_id=str(target["userId"]), message=text)

    async def _reply_message(self, input_data, context):
        target = _target_from(input_data, context)
        text = _require_non_empty(input_data.get("text"), "text")
        message_type = _require_message_type(target)
        message_id = input_data.get("messageId") or target["messageId"]
        _require_non_empty(message_id, "messageId")
        reply_text = f"[CQ:reply,id={message_id}]{text}"
        if message_type == "group":
            _require_non_empty(target.get("groupId"), "groupId")
            return await self.bot.send_group_msg(
                group_id=str(target["groupId"]), message=reply_text
            )
        _require_non_empty(target.get("userId"), "userId")
        return await self.bot.send_private_msg(
            user_id=str(target["userId"]), message=reply_text
        )


def _target_from(input_data, context):
    metadata = context.get("metadata", {})
    if "chat" in input_data:
        chat = input_data["chat"]
        message_type = chat.get("type")
        return {
            "messageType": message_type,
            "groupId": chat.get("groupId"),
            "userId": chat.get("userId"),
            "messageId": input_data.get("messageId") or metadata.get("messageId"),
        }
    return {
        "messageType": input_data.get("messageType") or metadata.get("messageType"),
        "groupId": input_data.get("groupId") or metadata.get("groupId"),
        "userId": input_data.get("userId") or metadata.get("userId"),
        "messageId": input_data.get("messageId") or metadata.get("messageId"),
    }


def _require_non_empty(value, name):
    if value is None or value == "":
        raise ValueError(f"{name} is required")
    return value


def _require_message_type(target):
    message_type = target.get("messageType")
    if message_type not in {"group", "private"}:
        raise ValueError(f"Unsupported messageType: {message_type}")
    return message_type
