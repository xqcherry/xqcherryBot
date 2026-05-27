from datetime import datetime, timezone
import json
import asyncio


class AgentConnection:
    def __init__(self, send_json):
        self._send_json = send_json

    def send_json(self, payload):
        result = self._send_json(payload)
        return result


def session_id_from_event(event):
    message_type = _get(event, "message_type")
    if message_type == "group":
        return f"qq-group:{_get(event, 'group_id')}"
    if message_type == "private":
        return f"qq-user:{_get(event, 'user_id')}"
    raise ValueError(f"Unsupported message_type: {message_type}")


def user_message_from_event(event):
    message = observed_message_from_event(event)
    raw_text = message["text"]
    message.update(
        {
            "type": "user_message",
            "rawText": raw_text,
            "text": strip_agent_prefix(raw_text),
        }
    )
    return message


def observed_message_from_event(event):
    session_id = session_id_from_event(event)
    message_type = _get(event, "message_type")
    user_id = str(_get(event, "user_id"))
    message_id = str(_get(event, "message_id"))
    metadata = {
        "platform": "qq",
        "adapter": "nonebot-napcat",
        "messageType": message_type,
        "userId": user_id,
        "messageId": message_id,
    }
    if message_type == "group":
        metadata["groupId"] = str(_get(event, "group_id"))

    return {
        "type": "observed_message",
        "sessionId": session_id,
        "messageId": message_id,
        "senderId": user_id,
        "text": _get(event, "raw_message"),
        "timestamp": timestamp_from_event(event),
        "metadata": metadata,
    }


def gateway_message_from_event(event, *, trigger_prefix="#agent"):
    raw_text = _get(event, "raw_message")
    if isinstance(raw_text, str) and raw_text.startswith(trigger_prefix):
        return user_message_from_event(event)
    return observed_message_from_event(event)


async def handle_agent_event(
    bot,
    connection,
    event,
    *,
    authorizer_id,
    auto_decision=None,
):
    event_type = event.get("type")
    if event_type == "assistant_delta":
        return None
    if event_type == "final_result":
        result = event.get("result", "")
        session_id = event.get("sessionId", "")
        metadata = event.get("metadata") or {}
        if session_id.startswith("qq-group:"):
            await bot.send_group_msg(
                group_id=session_id.removeprefix("qq-group:"),
                message=result,
            )
        elif session_id.startswith("qq-user:"):
            await bot.send_private_msg(
                user_id=session_id.removeprefix("qq-user:"),
                message=result,
            )
        elif metadata.get("messageType") == "group":
            await bot.send_group_msg(group_id=metadata["groupId"], message=result)
        elif metadata.get("messageType") == "private":
            await bot.send_private_msg(user_id=metadata["userId"], message=result)
        return None
    if event_type == "permission_request":
        await bot.send_private_msg(
            user_id=str(authorizer_id),
            message=f"[agent permission] {event.get('riskSummary', event.get('toolName'))}",
        )
        if auto_decision in {"allow", "deny"}:
            connection.send_json(
                {
                    "type": "permission_response",
                    "sessionId": event["sessionId"],
                    "toolCallId": event["toolCallId"],
                    "decision": auto_decision,
                    "responderId": str(authorizer_id),
                }
            )
        return None
    if event_type == "error":
        await bot.send_private_msg(
            user_id=str(authorizer_id),
            message=f"[agent error] {event.get('error', 'unknown error')}",
        )
        return None
    return None


def strip_agent_prefix(text, prefix="#agent"):
    if not isinstance(text, str):
        return ""
    if text.startswith(prefix):
        return text[len(prefix) :].lstrip()
    return text


def timestamp_from_event(event):
    try:
        value = _get(event, "time")
    except (KeyError, AttributeError):
        return None
    return datetime.fromtimestamp(int(value), tz=timezone.utc).isoformat()


class GatewayWebSocketClient:
    def __init__(self, url, on_event, *, retry_seconds=3, connector=None):
        self.url = url
        self.on_event = on_event
        self.retry_seconds = retry_seconds
        self._connector = connector
        self._socket = None
        self._stopped = asyncio.Event()

    async def send_json(self, payload):
        if self._socket is None:
            raise RuntimeError("Gateway websocket is not connected")
        await self._socket.send(json.dumps(payload, ensure_ascii=False))

    async def run_once(self):
        connector = self._connector or await _default_websocket_connector()
        async with await connector(self.url) as socket:
            self._socket = socket
            async for raw_event in socket:
                event = json.loads(raw_event)
                result = self.on_event(event)
                if hasattr(result, "__await__"):
                    await result

    async def run_forever(self):
        while not self._stopped.is_set():
            try:
                await self.run_once()
            except Exception:
                await asyncio.sleep(self.retry_seconds)

    def stop(self):
        self._stopped.set()


async def _default_websocket_connector():
    try:
        import websockets
    except ImportError as error:
        raise RuntimeError(
            "GatewayWebSocketClient requires the optional 'websockets' package"
        ) from error

    return websockets.connect


def _get(event, key):
    if isinstance(event, dict):
        return event[key]
    return getattr(event, key)
