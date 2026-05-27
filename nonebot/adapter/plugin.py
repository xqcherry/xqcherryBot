"""Optional NoneBot plugin entrypoint.

The unit-tested adapter helpers avoid importing NoneBot directly. Deployments can
import this module from a NoneBot project and wire its handlers to local policy.
"""

from .adapter import (
    AgentConnection,
    GatewayWebSocketClient,
    gateway_message_from_event,
    handle_agent_event,
    observed_message_from_event,
    user_message_from_event,
)
from .tools import NapCatTools

__all__ = [
    "AgentConnection",
    "GatewayWebSocketClient",
    "gateway_message_from_event",
    "NapCatTools",
    "handle_agent_event",
    "observed_message_from_event",
    "user_message_from_event",
]
