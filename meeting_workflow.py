"""Meeting intake checks and the ordered material catalog."""
from datetime import date, timedelta
import json
import os
from pathlib import Path
import re

from meeting_export import pdf_document, word_document

directory_override = Path(os.environ["SEI_DIRECTORY_FILE"]) if "SEI_DIRECTORY_FILE" in os.environ else Path(__file__).with_name(".sei-directory.json")
directory_file = directory_override if directory_override.is_file() else Path(__file__).with_name("sei_directory.json")
SEI_DIRECTORY = json.loads(directory_file.read_text(encoding="utf-8"))


def fill_sei_title(person):
    if person["type"] == "sei" and (not person["title"] or person.get("title_source") in ("mock", "directory")):
        title = SEI_DIRECTORY["titles"].get("".join(person["name"].split()))
        person["title"] = title or ""
        person.pop("title_source", None)
        if title:
            person["title_source"] = "mock" if SEI_DIRECTORY["mock"] else "directory"
    return person

MATERIALS = {
    "handbook": ("会议手册", "整理会议信息、议程、组织分工与会务提示。未确认的议程和分工清楚标明待确认。"),
    "roster": ("会议名单", "按主办方和外部参会方分组。逐一列出人员姓名和职务，外方另列公司。"),
    "notice": ("会议通知", "写成可审阅的会议通知，列明主题、时间、会议室、参会对象和已确认的要求。"),
    "seat_plan": ("会议座位图", ""),
    "table_tents": ("桌签", "为名单中的每位参会人制作独立桌签，逐人输出。有中文和英文两种版本要求时给出中文姓名及英文姓名，英文未提供时给出拼音建议并标明待核对。"),
    "dining_plan": ("就餐餐桌图", "按桌分组列出人员，以桌位图形式编排。场地布局和桌数未经确认时明确标为建议。仅汇总需要协调的餐饮事项，避免将个人忌口写进公开桌次表。"),
}

INTAKE_TASK = """收集本场会议资料，处理用户提出的修改。资料可按任意顺序提供。
会议信息包括主题、日期、时间、会议室。第 2 步先核齐名单和职务：SEI 人员只需报姓名，应用自动查职务；用户本轮明确提供或更正职务时才填写其 title，否则沿用原档案中同一人的职务或留空等待查询。外方须记录用户提供的公司、姓名和职务；用户只给了部分资料时照实保存，未提供的留空，不得从共享记忆、旧会议或职位猜测中补齐。用户明确表示没有外方时，facts.no_external_attendees 返回 true，并从完整名单移除外方；有外方时返回 false，未提供此信息时省略。每次先核实双方姓名和职务，名单不齐时绝不要同时追问用餐。用户主动提供用餐信息时可先记录。需要用餐时记录明确的特殊需求；没有特殊需求则记录“无”。没有提到的字段不得推断。每天的当前日期由应用提供，可据此解释相对日期。
仅分析用户明确表达的最新内容。facts 返回本轮新增或更正的字段。participants 未变化时返回 null，否则根据旧档案和最新指示返回合并后的完整当前名单，明确清空时返回空数组。未知的 type 留空。meal 未变化则返回 null。明确取消用餐须记录 false。已有资料齐备时，应用会自行发出制作确认。不得在这个接口生成材料、宣布制作完成或承诺已改好。
用户要求改已有或排队的材料时，在 revision 中提供材料 key 和修改指示，等待应用处理；若只改会议基本资料，通过 facts、participants 或 meal 更新，勿重复提交 revision。用户明确同意开始或继续时 action 为 start 或 resume；用户咨询、犹豫或提出修改时留空。已经有人询问中文或中英桌签时，按用户清楚表态填 tent_language 为 zh 或 zh-en，其他时候留空。
严格返回 JSON 对象：{"reply":"简短、得体的答复；资料不足时优先问一项","meeting":{"facts":{"topic":"主题","date":"YYYY-MM-DD","time":"HH:mm","location":"会议室","attendee_count":null,"no_external_attendees":null},"participants":null,"meal":null,"action":"","tent_language":"","revision":null},"shared_memory_patch":{"facts":[],"preferences":[]}}。participants 的元素结构为 {"type":"sei|visitor|","company":"","name":"","title":"","english_name":""}。meal 的结构为 {"required":null,"special_diet":""}。revision 的结构为 {"key":"handbook|roster|notice|seat_plan|table_tents|dining_plan","instruction":"修改内容"}。只返回 JSON。"""


def fields_missing(profile):
    facts, attendees, meal = profile["facts"], profile["participants"], profile["meal"]
    missing = [label for key, label in (
        ("topic", "会议主题"), ("date", "会议日期"), ("time", "会议时间"), ("location", "会议室")
    ) if not facts.get(key)]
    if (not any(person["type"] == "sei" for person in attendees)
        or not (facts.get("no_external_attendees") is True or any(person["type"] == "visitor" for person in attendees))
        or any(
            not person["name"] or not person["title"] or person["type"] not in ("sei", "visitor")
            or (person["type"] == "visitor" and not person["company"])
            for person in attendees
        )
    ):
        missing.append("完整参会名单")
    count = facts.get("attendee_count")
    if str(count).isdigit() and int(count) != len(attendees):
        missing.append("参会名单与人数一致")
    if meal["required"] is None:
        missing.append("是否用餐")
    elif meal["required"] and not meal["special_diet"]:
        missing.append("特殊餐饮需求")
    return missing


def ordered_materials(profile):
    return [key for key in MATERIALS if key != "dining_plan" or profile["meal"]["required"] is True]


def seat_preview(profile):
    people = profile["participants"]
    lines = ["会议座位图 · 模拟示意", "按名单顺序排位，供预览和编辑。实际座次请以确认后的安排为准。", "", "【主席台方向】"]
    for start in range(0, len(people), 4):
        slots = [f"{n + 1:02d} {people[n]['name']}" for n in range(start, min(start + 4, len(people)))]
        lines.append(f"第 {start // 4 + 1} 排")
        lines.append("  ｜  ".join(slots[:2]) + ("    走道    " + "  ｜  ".join(slots[2:]) if len(slots) > 2 else ""))
    return "\n".join(lines)


def export_bundle(profile, materials, file_format):
    sections = [(f"{profile['facts']['topic']} · 会议材料", "")]
    for key in ordered_materials(profile):
        sections.append((MATERIALS[key][0], materials[key]))
    if file_format == "pdf":
        return pdf_document(sections), "application/pdf"
    return word_document(sections), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def extract_meeting_basics(text, reference_day):
    """Extract explicitly stated basics, keeping names and attendee text out of this path."""
    text = re.split(r"来访人员|参会人员|参会名单|外部来宾", text, maxsplit=1)[0][:700]
    if re.search(r"举个例子|举例|如果|假设|不在|不开|不召开|是否|能不能", text):
        return {}
    if not re.search(r"会议|交流会|座谈会|评审会|研讨会|(?:召开|举行|举办)", text):
        return {}
    facts = {}
    date_match = re.search(r"(?<!\d)(?:(\d{4})(?:年|[-/]))?(\d{1,2})(?:月|[-/])(\d{1,2})(?:日|号)?(?!\d)", text)
    try:
        if date_match:
            year = int(date_match[1]) if date_match[1] else reference_day.year
            facts["date"] = date(year, int(date_match[2]), int(date_match[3])).isoformat()
        else:
            relative = re.search(r"今天|今日|明天|明日|后天|昨天", text)
            if relative:
                days = {"今天": 0, "今日": 0, "明天": 1, "明日": 1, "后天": 2, "昨天": -1}
                facts["date"] = (reference_day + timedelta(days=days[relative[0]])).isoformat()
    except ValueError:
        pass

    time_expression = re.search(
        r"(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*"
        r"(?<![0-9])([0-9]{1,2}|[零一二两三四五六七八九十]{1,3})"
        r"(?:[:：]([0-9]{2})(?![0-9])|(?:点|时(?=半|[0-9零一二两三四五六七八九十]|[，,。；;\s]|$))(半|[0-9]{1,2}|[零一二两三四五六七八九十]{1,3})?分?)",
        text,
    )
    if time_expression:
        period, hour_text, clock_minutes, spoken_minutes = time_expression.groups()
        hour = chinese_number(hour_text)
        minute = 30 if spoken_minutes == "半" else chinese_number(clock_minutes or spoken_minutes or "0")
        if period in ("下午", "傍晚", "晚上") and 1 <= hour < 12:
            hour += 12
        elif period == "中午" and 1 <= hour <= 2:
            hour += 12
        elif period == "凌晨" and hour == 12:
            hour = 0
        if 0 <= hour < 24 and 0 <= minute < 60:
            facts["time"] = f"{hour:02d}:{minute:02d}"

    room = re.search(r"(?<![A-Za-z0-9])([A-Za-z]?\d{1,6}(?:[-–]\d{1,4})?\s*(?:号\s*)?会议室)", text)
    if not room:
        room = re.search(r"(?:地点|会议室)\s*[:：]\s*([^，,。；;\n]{1,35})", text)
    if room:
        facts["location"] = room[1].strip()

    topic = re.search(r"(?:会议主题|主题)\s*[:：]\s*([^，,。；;\n]{1,80})", text)
    if not topic:
        topic = re.search(r"(?:召开|举行|举办)\s*([^，,。；;\n]{1,70}?(?:会议(?!室)|交流会|座谈会|评审会|研讨会))", text)
    if topic:
        name = topic[1].strip(' “”。"《》')
        if name and re.sub(r"(?:会议|交流会|座谈会|评审会|研讨会)$", "", name).strip():
            facts["topic"] = name
    if not ("topic" in facts or "location" in facts or re.search(r"会议(?:日期|时间)|开会时间", text)):
        return {}
    return facts


def chinese_number(value):
    if value.isascii() and value.isdecimal():
        return int(value)
    digits = {key: digit for digit, key in enumerate("零一二三四五六七八九")}
    digits["两"] = 2
    if "十" in value:
        tens, ones = value.split("十", 1)
        return digits.get(tens, 1) * 10 + digits.get(ones, 0)
    return int("".join(str(digits[char]) for char in value))
