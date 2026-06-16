import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "nonebot"))

from adapter.adapter import AgentConnection, handle_agent_event
from adapter.tools import NapCatTools


class FakeBot:
    def __init__(self):
        self.calls = []

    async def get_group_msg_history(self, **kwargs):
        self.calls.append(("get_group_msg_history", kwargs))
        return {"messages": []}

    async def get_group_info(self, **kwargs):
        self.calls.append(("get_group_info", kwargs))
        return {"group_name": "test"}

    async def get_stranger_info(self, **kwargs):
        self.calls.append(("get_stranger_info", kwargs))
        return {"nickname": "alice"}

    async def send_group_msg(self, **kwargs):
        self.calls.append(("send_group_msg", kwargs))
        return {"message_id": "group-message"}

    async def send_private_msg(self, **kwargs):
        self.calls.append(("send_private_msg", kwargs))
        return {"message_id": "private-message"}


class FakeConnection:
    def __init__(self):
        self.sent = []

    def send_json(self, payload):
        self.sent.append(payload)


class AgentBridgeFinalResultTests(unittest.IsolatedAsyncioTestCase):
    async def test_empty_final_result_is_not_sent(self):
        bot = FakeBot()

        await handle_agent_event(
            bot,
            AgentConnection(FakeConnection().send_json),
            {
                "type": "final_result",
                "sessionId": "qq-group:1000",
                "result": "   ",
                "replyToMessageId": "m1",
            },
            authorizer_id="admin",
        )

        self.assertEqual(bot.calls, [])

    async def test_group_final_result_is_split_on_blank_lines(self):
        bot = FakeBot()

        await handle_agent_event(
            bot,
            AgentConnection(FakeConnection().send_json),
            {
                "type": "final_result",
                "sessionId": "qq-group:1000",
                "result": "笑死我了 我一直都很正常好吧\n\n是你在那发#指令发魔怔了吧",
            },
            authorizer_id="admin",
        )

        self.assertEqual(
            bot.calls,
            [
                ("send_group_msg", {"group_id": "1000", "message": "笑死我了 我一直都很正常好吧"}),
                ("send_group_msg", {"group_id": "1000", "message": "是你在那发#指令发魔怔了吧"}),
            ],
        )

    async def test_single_newline_stays_in_one_message(self):
        bot = FakeBot()

        await handle_agent_event(
            bot,
            AgentConnection(FakeConnection().send_json),
            {
                "type": "final_result",
                "sessionId": "qq-group:1000",
                "result": "第一行\n第二行",
            },
            authorizer_id="admin",
        )

        self.assertEqual(
            bot.calls,
            [("send_group_msg", {"group_id": "1000", "message": "第一行\n第二行"})],
        )

    async def test_private_final_result_is_split_on_blank_lines(self):
        bot = FakeBot()

        await handle_agent_event(
            bot,
            AgentConnection(FakeConnection().send_json),
            {
                "type": "final_result",
                "sessionId": "qq-user:42",
                "result": "第一段\n\n第二段",
            },
            authorizer_id="admin",
        )

        self.assertEqual(
            bot.calls,
            [
                ("send_private_msg", {"user_id": "42", "message": "第一段"}),
                ("send_private_msg", {"user_id": "42", "message": "第二段"}),
            ],
        )


class AgentBridgeToolRequestTests(unittest.IsolatedAsyncioTestCase):
    async def test_tool_request_executes_napcat_tool_and_returns_result(self):
        bot = FakeBot()
        connection = FakeConnection()
        tools = NapCatTools(bot)

        await handle_agent_event(
            bot,
            AgentConnection(connection.send_json),
            {
                "type": "tool_request",
                "requestId": "req-1",
                "sessionId": "qq-group:1000",
                "toolCallId": "call-send",
                "toolName": "send_message",
                "input": {"text": "hello"},
                "context": {
                    "metadata": {
                        "messageType": "group",
                        "groupId": "1000",
                        "userId": "42",
                        "messageId": "m1",
                    }
                },
            },
            authorizer_id="admin",
            tools=tools,
        )

        self.assertEqual(
            bot.calls,
            [("send_group_msg", {"group_id": "1000", "message": "hello"})],
        )
        self.assertEqual(
            connection.sent,
            [
                {
                    "type": "tool_result",
                    "requestId": "req-1",
                    "sessionId": "qq-group:1000",
                    "toolCallId": "call-send",
                    "ok": True,
                    "result": {"message_id": "group-message"},
                }
            ],
        )

    async def test_tool_request_returns_error_when_execution_fails(self):
        bot = FakeBot()
        connection = FakeConnection()
        tools = NapCatTools(bot)

        await handle_agent_event(
            bot,
            AgentConnection(connection.send_json),
            {
                "type": "tool_request",
                "requestId": "req-2",
                "sessionId": "qq-user:42",
                "toolCallId": "call-reply",
                "toolName": "reply_message",
                "input": {"text": "hello", "messageId": ""},
                "context": {
                    "metadata": {
                        "messageType": "private",
                        "userId": "42",
                    }
                },
            },
            authorizer_id="admin",
            tools=tools,
        )

        self.assertEqual(connection.sent[0]["type"], "tool_result")
        self.assertEqual(connection.sent[0]["ok"], False)
        self.assertIn("messageId is required", connection.sent[0]["error"])


class NapCatToolValidationTests(unittest.IsolatedAsyncioTestCase):
    async def test_group_info_requires_group_id(self):
        tools = NapCatTools(FakeBot())

        with self.assertRaisesRegex(ValueError, "groupId is required"):
            await tools.call(
                "get_group_info",
                {},
                {"metadata": {"messageType": "private", "userId": "42"}},
            )

    async def test_send_message_rejects_unknown_message_type(self):
        tools = NapCatTools(FakeBot())

        with self.assertRaisesRegex(ValueError, "Unsupported messageType"):
            await tools.call(
                "send_message",
                {"text": "hello", "messageType": "guild", "userId": "42"},
                {},
            )

    async def test_reply_message_requires_message_id(self):
        tools = NapCatTools(FakeBot())

        with self.assertRaisesRegex(ValueError, "messageId is required"):
            await tools.call(
                "reply_message",
                {"text": "hello"},
                {"metadata": {"messageType": "private", "userId": "42"}},
            )


if __name__ == "__main__":
    unittest.main()
