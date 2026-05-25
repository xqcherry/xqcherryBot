from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta

try:
    import dateparser
except Exception:
    dateparser = None


class ReminderParseError(ValueError):
    pass


@dataclass(frozen=True)
class ParsedReminder:
    remind_at: datetime
    content: str
    time_text: str


_CN_NUM = {
    "零": 0,
    "〇": 0,
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
}
_NUM_TOKEN = r"\d{1,4}|[零〇一二两三四五六七八九十]{1,4}"


def parse_reminder_input(raw: str, now: datetime | None = None) -> ParsedReminder:
    text = raw.strip()
    if not text:
        raise ReminderParseError()

    base = (now or datetime.now()).replace(microsecond=0)
    parsed = _parse_with_local_rules(text, base) or _parse_with_dateparser(text, base)
    if not parsed:
        raise ReminderParseError()

    remind_at, end = parsed
    content = text[end:].strip(" ，,：:")
    if not content:
        raise ReminderParseError()
    if remind_at <= base:
        raise ReminderParseError()

    return ParsedReminder(remind_at=remind_at.replace(microsecond=0), content=content, time_text=text[:end].strip())


def _parse_with_local_rules(text: str, now: datetime) -> tuple[datetime, int] | None:
    parsers = (
        _parse_relative_delta,
        _parse_fixed_datetime,
        _parse_month_day_time,
        _parse_relative_day_time,
    )
    for parser in parsers:
        result = parser(text, now)
        if result:
            return result
    return None


def _parse_relative_delta(text: str, now: datetime) -> tuple[datetime, int] | None:
    match = re.match(rf"^\s*(?P<num>{_NUM_TOKEN})\s*(?P<unit>分钟|分|小时|个小时|天)后", text)
    if not match:
        return None

    value = _parse_number(match.group("num"))
    unit = match.group("unit")
    if unit in {"分钟", "分"}:
        delta = timedelta(minutes=value)
    elif unit in {"小时", "个小时"}:
        delta = timedelta(hours=value)
    else:
        delta = timedelta(days=value)
    return now + delta, match.end()


def _parse_fixed_datetime(text: str, now: datetime) -> tuple[datetime, int] | None:
    match = re.match(
        r"^\s*(?P<year>\d{4})[-/年](?P<month>\d{1,2})[-/月](?P<day>\d{1,2})(?:日|号)?\s+"
        rf"(?P<hour>{_NUM_TOKEN})(?:[:：点时])(?P<minute>\d{{1,2}})?(?:分)?",
        text,
    )
    if not match:
        return None

    hour, minute = _parse_clock(match, default_minute=0)
    return (
        datetime(int(match.group("year")), int(match.group("month")), int(match.group("day")), hour, minute),
        match.end(),
    )


def _parse_month_day_time(text: str, now: datetime) -> tuple[datetime, int] | None:
    match = re.match(
        rf"^\s*(?:(?P<month>\d{{1,2}})月)?(?P<day>\d{{1,2}})[日号]\s*"
        rf"(?P<period>凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*"
        rf"(?P<hour>{_NUM_TOKEN})(?:[:：点时])(?P<minute>\d{{1,2}})?(?:分|半)?",
        text,
    )
    if not match:
        return None

    month = int(match.group("month") or now.month)
    day = int(match.group("day"))
    hour, minute = _parse_clock(match, default_minute=0)
    hour = _apply_period(hour, match.group("period"))
    remind_at = datetime(now.year, month, day, hour, minute)
    if not match.group("month") and remind_at <= now:
        remind_at = datetime(now.year + 1, month, day, hour, minute)
    return remind_at, match.end()


def _parse_relative_day_time(text: str, now: datetime) -> tuple[datetime, int] | None:
    match = re.match(
        rf"^\s*(?P<day>今天|明天|后天)?\s*(?P<period>凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*"
        rf"(?P<hour>{_NUM_TOKEN})(?:[:：点时])(?P<minute>\d{{1,2}})?(?:分|半)?",
        text,
    )
    if not match or not (match.group("day") or match.group("period")):
        return None

    day_offset = {"今天": 0, "明天": 1, "后天": 2}.get(match.group("day") or "今天", 0)
    target_day = now.date() + timedelta(days=day_offset)
    hour, minute = _parse_clock(match, default_minute=0)
    hour = _apply_period(hour, match.group("period"))
    return datetime.combine(target_day, datetime.min.time()).replace(hour=hour, minute=minute), match.end()


def _parse_with_dateparser(text: str, now: datetime) -> tuple[datetime, int] | None:
    if dateparser is None:
        return None

    tokens = text.split()
    for end in range(min(5, len(tokens)), 0, -1):
        time_text = " ".join(tokens[:end])
        parsed = dateparser.parse(
            time_text,
            languages=["zh"],
            settings={
                "RELATIVE_BASE": now,
                "PREFER_DATES_FROM": "future",
                "RETURN_AS_TIMEZONE_AWARE": False,
            },
        )
        if parsed:
            return parsed.replace(microsecond=0), len(time_text)
    return None


def _parse_clock(match: re.Match[str], default_minute: int) -> tuple[int, int]:
    hour = _parse_number(match.group("hour"))
    minute_text = match.groupdict().get("minute")
    minute = int(minute_text) if minute_text else default_minute
    if match.group(0).endswith("半"):
        minute = 30
    if not 0 <= hour <= 23 or not 0 <= minute <= 59:
        raise ReminderParseError()
    return hour, minute


def _apply_period(hour: int, period: str | None) -> int:
    if period in {"下午", "傍晚", "晚上"} and hour < 12:
        return hour + 12
    if period == "中午" and hour < 11:
        return hour + 12
    if period in {"凌晨", "早上", "上午"} and hour == 12:
        return 0
    return hour


def _parse_number(text: str) -> int:
    if text.isdigit():
        return int(text)
    if text == "十":
        return 10
    if "十" in text:
        left, _, right = text.partition("十")
        tens = _CN_NUM.get(left, 1) if left else 1
        ones = _CN_NUM.get(right, 0) if right else 0
        return tens * 10 + ones

    value = 0
    for char in text:
        value = value * 10 + _CN_NUM[char]
    return value
