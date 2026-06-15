import asyncio
import os
from typing import Any

from nonebot import get_bot, get_driver, logger, on_message
from nonebot.adapters.onebot.v11 import Bot, MessageEvent

from adapter import (
    AgentConnection,
    GatewayWebSocketClient,
    NapCatTools,
    gateway_message_from_event,
    handle_agent_event,
)

AGENT_GATEWAY_URL = os.getenv("AGENT_GATEWAY_URL", "ws://127.0.0.1:8787")
AGENT_AUTHOR_QQ = os.getenv("AGENT_AUTHOR_QQ", "")
AGENT_AUTO_PERMISSION = os.getenv("AGENT_AUTO_PERMISSION")
AGENT_TRIGGER_PREFIX = os.getenv("AGENT_TRIGGER_PREFIX", "#agent")

gateway: GatewayWebSocketClient | None = None
gateway_task: asyncio.Task | None = None


def _event_brief(event: MessageEvent) -> dict[str, Any]:
    return {
        "message_type": getattr(event, "message_type", None),
        "group_id": str(getattr(event, "group_id", "")) or None,
        "user_id": str(getattr(event, "user_id", "")) or None,
        "message_id": str(getattr(event, "message_id", "")) or None,
        "raw_message": getattr(event, "raw_message", ""),
    }


def _is_supported_message(event: MessageEvent) -> bool:
    message_type = getattr(event, "message_type", None)
    return message_type in {"group", "private"}


def _is_self_message(bot: Bot, event: MessageEvent) -> bool:
    return str(getattr(event, "user_id", "")) == str(bot.self_id)


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


@get_driver().on_startup
async def start_agent_gateway_client() -> None:
    global gateway, gateway_task

    async def on_agent_event(event: dict[str, Any]) -> None:
        try:
            bot = get_bot()
        except Exception as error:
            logger.warning(f"Cannot get NoneBot bot for agent event: {error}")
            return

        connection = AgentConnection(
            send_json=lambda payload: asyncio.create_task(_send_to_gateway(payload))
        )

        try:
            await handle_agent_event(
                bot,
                connection,
                event,
                authorizer_id=AGENT_AUTHOR_QQ,
                auto_decision=AGENT_AUTO_PERMISSION,
                tools=NapCatTools(bot),
            )
        except Exception as error:
            logger.exception(f"Failed to handle agent event {event}: {error}")

    gateway = GatewayWebSocketClient(
        AGENT_GATEWAY_URL,
        on_event=on_agent_event,
        retry_seconds=3,
    )

    gateway_task = asyncio.create_task(gateway.run_forever())
    logger.info(f"Agent gateway client started: {AGENT_GATEWAY_URL}")


@get_driver().on_shutdown
async def stop_agent_gateway_client() -> None:
    global gateway, gateway_task

    if gateway is not None:
        gateway.stop()

    if gateway_task is not None:
        gateway_task.cancel()
        try:
            await gateway_task
        except asyncio.CancelledError:
            pass

    logger.info("Agent gateway client stopped")


agent_message = on_message(priority=50, block=False)


@agent_message.handle()
async def handle_qq_message(bot: Bot, event: MessageEvent) -> None:
    if not _is_supported_message(event):
        return

    if _is_self_message(bot, event):
        return

    try:
        payload = gateway_message_from_event(
            event,
            trigger_prefix=AGENT_TRIGGER_PREFIX,
        )
    except Exception as error:
        logger.warning(f"Failed to convert QQ event to agent payload: {_event_brief(event)} {error}")
        return

    await _send_to_gateway(payload)

    if payload["type"] == "user_message":
        logger.info(
            f"Forwarded triggered agent message: session={payload['sessionId']} "
            f"message_id={payload.get('messageId')}"
        )
    else:
        logger.debug(
            f"Forwarded observed message: session={payload['sessionId']} "
            f"message_id={payload.get('messageId')}"
        )
