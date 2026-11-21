"""Meeting intake checks and the ordered material catalog."""
from meeting_export import pdf_document, word_document

MATERIALS = {
    "handbook": ("会议手册", "整理会议信息、议程、组织分工与会务提示。未确认的议程和分工清楚标明待确认。"),
    "roster": ("会议名单", "按主办方和外部参会方分组。逐一列出已确认人员，访客附公司和职务。"),
    "notice": ("会议通知", "写成可审阅的会议通知，列明主题、时间、会议室、参会对象和已确认的要求。"),
    "seat_plan": ("会议座位图", ""),
    "table_tents": ("桌签", "为名单中的每位参会人制作独立桌签，逐人输出。有中文和英文两种版本要求时给出中文姓名及英文姓名，英文未提供时给出拼音建议并标明待核对。"),
    "dining_plan": ("就餐餐桌图", "按桌分组列出人员，以桌位图形式编排。场地布局和桌数未经确认时明确标为建议。仅汇总需要协调的餐饮事项，避免将个人忌口写进公开桌次表。"),
}

INTAKE_TASK = """你是小会，负责收集会议资料和沟通修改。资料可按任意顺序提供。
会议信息包括主题、日期、时间、会议室。参会人包括 SEI 人员姓名，以及外部人员的公司、姓名、职务。如果需要用餐，必须明确特殊需求；没有则记录“无”。没有提到的字段不得推断。每天的当前日期由应用提供，可据此解释相对日期。
仅分析用户明确表达的最新内容。facts 返回本轮新增或更正的字段。participants 未变化时返回 null，否则根据旧档案和最新指示返回合并后的完整当前名单，明确清空时返回空数组。未知的 type 留空。meal 未变化则返回 null。明确取消用餐须记录 false。已有资料齐备时，应用会自行发出制作确认。不得在这个接口生成材料、宣布制作完成或承诺已改好。
用户要求改已有或排队的材料时，在 revision 中提供材料 key 和修改指示，等待应用处理；若只改会议基本资料，通过 facts、participants 或 meal 更新，勿重复提交 revision。用户明确同意开始或继续时 action 为 start 或 resume；用户咨询、犹豫或提出修改时留空。已经有人询问中文或中英桌签时，按用户清楚表态填 tent_language 为 zh 或 zh-en，其他时候留空。
严格返回 JSON 对象：{"reply":"简短、得体的答复；资料不足时优先问一项","meeting":{"facts":{"topic":"主题","date":"YYYY-MM-DD","time":"HH:mm","location":"会议室","attendee_count":null},"participants":null,"meal":null,"action":"","tent_language":"","revision":null},"shared_memory_patch":{"facts":[],"preferences":[]}}。participants 的元素结构为 {"type":"sei|visitor|","company":"","name":"","title":"","english_name":""}。meal 的结构为 {"required":null,"special_diet":""}。revision 的结构为 {"key":"handbook|roster|notice|seat_plan|table_tents|dining_plan","instruction":"修改内容"}。只返回 JSON。"""


def fields_missing(profile):
    facts, attendees, meal = profile["facts"], profile["participants"], profile["meal"]
    missing = [label for key, label in (
        ("topic", "会议主题"), ("date", "会议日期"), ("time", "会议时间"), ("location", "会议室")
    ) if not facts.get(key)]
    if not attendees or any(
        not person["name"] or person["type"] not in ("sei", "visitor")
        or (person["type"] == "visitor" and (not person["company"] or not person["title"]))
        for person in attendees
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
