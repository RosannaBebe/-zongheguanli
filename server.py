#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Minimal same-origin web and OpenAI-compatible model service for 综智助手."""
from __future__ import annotations
import json, mimetypes, os, re, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from datetime import date, datetime
from zoneinfo import ZoneInfo
from meeting_workflow import INTAKE_TASK, MATERIALS, export_bundle, extract_meeting_basics, fields_missing, ordered_materials, seat_preview

ROOT = Path(__file__).resolve().parent

def load_dotenv():
    env_file = ROOT / ".env"
    if not env_file.exists(): return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line=line.strip()
        if not line or line.startswith("#") or "=" not in line: continue
        key,value=line.split("=",1)
        os.environ.setdefault(key.strip(),value.strip().strip("\"'"))
load_dotenv()
BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1").rstrip("/")
MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-flash")
API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
PORT=int(os.getenv("PORT","8765"))
ASSISTANTS={"meeting":"会务助手","information":"政务信息助手","official_document":"公文助手","knowledge":"综合知识库"}
BASE_PERSONA="【共同服务定位】你叫赛博小潘，是国企性质工程设计院综合管理部的综智助手。你在首页和会务、政务信息、公文、综合知识库四个工作区使用同一个身份，按当前工作区的任务要求办理。切换工作区时，说明你将在该业务工作区继续服务。历史对话中出现的旧称呼不改变当前身份。服务对象包括院领导和各级管理人员。无论用户的身份、职务或层级，一律按服务院领导的标准对待，将每位用户都视为院领导级服务对象。具有很强的服务意识：及时回应、积极承接、主动梳理、周到跟进；始终称呼“您”，语气谦逊温和、专业稳重，严禁使用“你”或命令、敷衍、怠慢的表达。准确领会指示，主动梳理安排、提醒缺项、复核关键信息，并优先交付可直接审阅或使用的成果。保持稳重、专业、响应及时，不夸大、不谄媚、不堆砌客套话，也不替领导擅自作决定。已确认事项持续沿用，用户最新明确意见优先。不得虚构事实、制度依据、来源或已执行的现实操作。对外以亲切、稳重的工作伙伴口吻交流，不冒充现实中的真人；日常交流不使用“智能体”或“AI助手”称呼自己。用户直接询问身份或所用模型时，应坦诚说明自己的岗位角色及实际模型名称，不回避、不编造。"
HOME_AGENT_TASK="先听懂用户手头的事情，明确后在对应业务工作区继续处理。你可以识别会务、政务信息、公文、综合知识查询四类需求。需要分流时，帮助用户确认要先办理的事项。只有用户已经明确提出一个能由单一助手承接的任务，才返回对应 intent 与一句简短承接话。问你是谁、能做什么、让你猜、闲聊，或同时涉及多个助手但未指定先办什么时，intent 必须为 null，直接回答用户当前问题；需要继续梳理时，只问一个能缩小范围的问题。不要回复“请您选择相应助手”，不要机械罗列四个入口，不要连续抛多个问题。用户说“不知道要做什么”时，帮助其从当前工作、希望形成的结果、时间紧迫程度等角度循序梳理；可以先问眼下最想解决的一件事，不催促。结合已有对话推进，避免重复问已回答的问题。只在把握充分时路由；confidence低于0.72就继续澄清。handoff_summary只概括此次需求和已确认条件，供对应工作区接续，不加入猜测。输出严格JSON：{\"intent\":\"meeting|information|official_document|knowledge|null\",\"confidence\":0到1,\"reply\":\"首页回复\",\"handoff_summary\":\"交接摘要\",\"shared_memory_patch\":{\"facts\":[],\"preferences\":[]}}。不在JSON外输出文字。"
ASSISTANT_TASKS={
 "meeting": INTAKE_TASK,
 "information":"帮助搜集和梳理政务要情、核验来源、提炼观点并整理专报。明确主题、时间范围、地域、受众和来源要求；区分事实、判断与建议，标注待核实内容，不编造新闻、数据或出处。",
 "official_document":"协助起草、润色、校对和规范公文。先确认文种、标题、主送对象、目的、依据、关键事实和篇幅；保留用户提供的事实，不擅自杜撰政策依据或发文信息，并清楚呈现可直接使用的正文和需要确认的字段。",
 "knowledge":"帮助查找制度、模板、历史案例和会务/政务/公文材料。只依据本次对话及用户提供的知识材料回答；材料不足时明确说明并询问上传或补充资料，不虚构制度条款、来源或历史记录。"
}

def parse_json_object(text:str):
    match=re.search(r"\{.*\}",text,re.S)
    if not match:return None
    try:
        value=json.loads(match.group())
        return value if isinstance(value,dict) else None
    except Exception:return None

def clean_shared_memory(value):
    if not isinstance(value,dict):return {"facts":[],"preferences":[]}
    result={}
    for key in ("facts","preferences"):
        items=value.get(key,[])
        if not isinstance(items,list):items=[]
        cleaned=[]
        for item in items[-20:]:
            if isinstance(item,str) and item.strip():cleaned.append(item.strip()[:240])
        result[key]=cleaned
    return result

def clean_memory_patch(value):
    if not isinstance(value,dict):return {"facts":[],"preferences":[]}
    return clean_shared_memory(value)

def clean_meeting_profile(value):
    if not isinstance(value, dict):
        value = {}
    raw_facts = value.get("facts")
    raw_facts = raw_facts if isinstance(raw_facts, dict) else {}
    facts = {
        key: item.strip()[:250] if isinstance(item, str) else item
        for key, item in raw_facts.items()
        if key in {"topic", "date", "time", "location", "attendee_count"}
        and ((isinstance(item, str) and item.strip()) or type(item) is int)
    }
    participants = []
    raw_people = value.get("participants")
    for person in raw_people[:100] if isinstance(raw_people, list) else []:
        if isinstance(person, dict):
            participant = {
                field: clean_text(person.get(field), 160)
                for field in ("company", "name", "title", "english_name")
            }
            participant["type"] = person.get("type") if person.get("type") in ("sei", "visitor") else ""
            participants.append(participant)
    meal = value.get("meal")
    meal = meal if isinstance(meal, dict) else {}
    required = meal.get("required") if type(meal.get("required")) is bool else None
    language = value.get("tentLanguage")
    return {
        "facts": facts,
        "participants": participants,
        "meal": {"required": required, "special_diet": clean_text(meal.get("special_diet"), 500) if required is not False else ""},
        "tent_language": language if language in ("zh", "zh-en") else "",
    }


def clean_text(value, limit=18000):
    return value.strip()[:limit] if isinstance(value, str) else ""


def clean_materials(value):
    if not isinstance(value, dict):
        return {}
    return {key: clean_text(value.get(key)) for key in MATERIALS if clean_text(value.get(key))}


def direct_intent(text:str)->str:
    # Explicit assistant requests and references to prior meetings route to their dedicated assistant first.
    if re.search(r"打开.{0,8}会务助手|进入.{0,8}会务助手|会务助手",text): return "meeting"
    if re.search(r"打开.{0,10}(政务信息助手|信息助手)|进入.{0,10}(政务信息助手|信息助手)|政务信息助手",text): return "information"
    if re.search(r"打开.{0,8}公文助手|进入.{0,8}公文助手|公文助手",text): return "official_document"
    if re.search(r"打开.{0,10}(综合知识库|知识库)|进入.{0,10}(综合知识库|知识库)|综合知识库",text): return "knowledge"
    if re.search(r"(之前|上次|刚才|原来|那场|这场|继续|接着|讨论过|已经聊过).{0,12}(会议|会务|参会|人数|材料)|(会议|会务).{0,10}(改成|调整|更新|继续|接着|之前|上次)",text): return "meeting"
    if re.search(r"(查询|查找|查阅|搜一下|历史|以前|制度|模板|案例)",text) and re.search(r"(会议制度|会务制度|会议模板|会议案例|公文|信息|资料|要情|制度|模板|案例)",text): return "knowledge"
    if re.search(r"知识库",text): return "knowledge"
    if re.search(r"办会|办个会|开会|会议|会务|参会|会议室|会场",text): return "meeting"
    if re.search(r"要情|专报|新闻|信息稿|搜集.{0,4}信息",text): return "information"
    if re.search(r"公文|通知|请示|起草|润色|校对",text): return "official_document"
    return ""

class ModelServiceError(RuntimeError):
    pass


def llm(messages, max_tokens=1200, required_json_key=None):
    if not API_KEY:
        raise ModelServiceError("服务端未设置 DEEPSEEK_API_KEY")

    request_messages = [dict(message) for message in messages]
    if request_messages and request_messages[0].get("role") == "system":
        request_messages[0]["content"] += (
            "\n\n本次实际调用模型名称：" + MODEL + "。如果用户询问模型，请如实回答这个名称。"
        )
    payload = {
        "model": MODEL,
        "messages": request_messages,
        "temperature": 0.3,
        "max_tokens": max_tokens,
        "thinking": {"type": "disabled"},
        "response_format": {"type": "json_object"},
    }
    for attempt in range(2):
        request = urllib.request.Request(
            BASE_URL + "/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Authorization": "Bearer " + API_KEY, "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                data = json.load(response)
            content = data["choices"][0]["message"]["content"]
            parsed = parse_json_object(content) if isinstance(content, str) else None
            if parsed is None or (required_json_key and not isinstance(parsed.get(required_json_key), dict)):
                raise ValueError("invalid JSON content or required object missing")
            return content
        except urllib.error.HTTPError as error:
            if attempt == 0 and error.code in (408, 500, 502, 503, 504):
                continue
            reason = {
                401: "DeepSeek API 密钥无效",
                402: "DeepSeek API 余额不足",
                429: "DeepSeek API 请求过多，请稍后重试",
            }.get(error.code, f"DeepSeek API 返回 HTTP {error.code}")
            raise ModelServiceError(reason) from None
        except (OSError, TimeoutError):
            if attempt == 0:
                continue
            raise ModelServiceError("暂时无法连接 DeepSeek API") from None
        except (KeyError, IndexError, TypeError, ValueError):
            if attempt == 0:
                request_messages[0]["content"] += (
                    "\n本次请直接返回包含所需字段的有效 JSON 对象。"
                    "JSON 必须完整且包含非空内容，无需 Markdown 代码围栏。"
                )
                if required_json_key:
                    request_messages[0]["content"] += f"顶层必须有 {required_json_key} 对象。"
                continue
            raise ModelServiceError("模型暂未返回有效回复，请重试") from None


class Handler(BaseHTTPRequestHandler):
    server_version="Zongzhi/1.0"
    def log_message(self,fmt,*args): print("%s - %s"%(self.address_string(),fmt%args))
    def send_json(self,status,obj):
        raw=json.dumps(obj,ensure_ascii=False).encode();self.send_response(status);self.send_header("Content-Type","application/json; charset=utf-8");self.send_header("Content-Length",str(len(raw)));self.send_header("Cache-Control","no-store");self.end_headers();self.wfile.write(raw)
    def read_json(self):
        n=int(self.headers.get("Content-Length","0"))
        if n>1_000_000: raise ValueError("请求内容过大")
        return json.loads(self.rfile.read(n) or b"{}")
    def do_GET(self):
        if self.path=="/api/ai/status": return self.send_json(200,{"configured":bool(API_KEY),"model":MODEL,"fallback_models":[],"base_url":BASE_URL})
        if self.path == "/meeting.js":
            raw = (ROOT / "meeting.js").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(raw)
            return
        if self.path in ("/health","/healthz"): return self.send_json(200,{"ok":True})
        # Single-page app: all module paths serve the same front end.
        if self.path.split("?",1)[0] in ("/","/meeting","/information","/official-documents","/knowledge"):
            raw=(ROOT/"index.html").read_bytes();self.send_response(200);self.send_header("Content-Type","text/html; charset=utf-8");self.send_header("Content-Length",str(len(raw)));self.end_headers();self.wfile.write(raw);return
        self.send_json(404,{"error":"未找到页面"})
    def do_POST(self):
        try: data=self.read_json()
        except Exception as exc: return self.send_json(400,{"error":str(exc)})
        if not isinstance(data, dict):
            return self.send_json(400, {"error": "请求内容必须是 JSON 对象"})
        try:
            return self.handle_model_request(data)
        except ModelServiceError as error:
            status = 502 if API_KEY else 503
            return self.send_json(status, {"error": str(error)})

    def handle_material(self, data):
        profile = clean_meeting_profile(data.get("profile"))
        materials = clean_materials(data.get("materials"))
        ordered = ordered_materials(profile)
        missing = fields_missing(profile)
        if missing:
            return self.send_json(409, {"error": "请补齐：" + "、".join(missing)})
        key = data.get("key")
        if key not in ordered:
            return self.send_json(400, {"error": "本场会议没有这项材料"})
        revision = data.get("revision") is True
        if revision and key not in materials:
            return self.send_json(409, {"error": "尚未生成这份材料"})
        if not revision:
            state = data.get("profile", {}).get("production")
            if not isinstance(state, dict) or state.get("started") is not True:
                return self.send_json(409, {"error": "请先确认开始制作材料"})
            next_key = next((name for name in ordered if name not in materials), None)
            if key != next_key:
                return self.send_json(409, {"error": "请按当前制作顺序继续"})
        if key == "table_tents" and profile["tent_language"] not in ("zh", "zh-en"):
            return self.send_json(409, {"error": "请先确认桌签语言"})
        if key == "seat_plan" and not revision:
            preview = seat_preview(profile)
            notes = clean_text(data.get("instructions"), 2400)
            if notes:
                preview += "\n\n待应用的座次要求：" + notes
            return self.send_json(200, {"key": key, "content": preview, "mock": True})

        title, task = MATERIALS[key]
        if key == "seat_plan":
            task = "编辑用户提供的模拟座位图，保留模拟示意的标识并应用指定要求。"
        language = {"zh": "仅制作中文桌签", "zh-en": "为每人列出中文及英文桌签，英文名缺失时以待核对的拼音标注"}
        if key == "table_tents":
            task += "语言要求：" + language[profile["tent_language"]] + "。"
        system = BASE_PERSONA + (
            "\n当前工作区：会务助手。仅处理本次指定的这一份会议材料。"
            "\n输出一个 JSON 对象，字段 content 是可直接审阅的纯文本正文。"
            "\n未提供的事实标为待确认，不擅自补造。历史会议的参考材料只用来参考结构和表述。"
        )
        source = {
            "材料": title, "要求": task, "本场会议": profile,
            "当前版本": materials.get(key, "") if revision else "",
            "其他已完成材料摘要": {k: v[:900] for k, v in materials.items() if k != key},
            "用户修改意见": clean_text(data.get("instructions"), 2400),
            "材料库参考": clean_text(data.get("reference"), 3800),
        }
        if revision:
            system += "\n请保留当前稿件未被要求修改的内容，只应用本轮修改意见。"
        answer = llm([{"role": "system", "content": system}, {"role": "user", "content": json.dumps(source, ensure_ascii=False)}], 4800)
        result = parse_json_object(answer) or {}
        content = clean_text(result.get("content"))
        if not content:
            raise ModelServiceError("模型未返回可用的" + title)
        return self.send_json(200, {"key": key, "content": content, "mock": key == "seat_plan"})

    def download_materials(self, data):
        profile = clean_meeting_profile(data.get("profile"))
        materials = clean_materials(data.get("materials"))
        file_format = data.get("format")
        if file_format not in ("pdf", "docx"):
            return self.send_json(400, {"error": "请选择 PDF 或 Word 格式"})
        if fields_missing(profile) or any(key not in materials for key in ordered_materials(profile)):
            return self.send_json(409, {"error": "请先完成本场会议的全部材料"})
        payload, content_type = export_bundle(profile, materials, file_format)
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def recover_meeting_basics(self, data):
        recovered = {}
        messages = data.get("messages")
        for message in messages[-60:] if isinstance(messages, list) else []:
            if not isinstance(message, dict) or message.get("role") != "user":
                continue
            stamp = clean_text(message.get("at"), 40)
            try:
                at = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
                day = at.astimezone(ZoneInfo("Asia/Shanghai")).date()
            except ValueError:
                # Without the original date, do not resolve relative dates from archived chats.
                continue
            recovered.update(extract_meeting_basics(clean_text(message.get("text"), 6000), day))
        return self.send_json(200, {"facts": recovered})

    def handle_model_request(self, data):
        if self.path == "/api/meeting/recover-basics":
            return self.recover_meeting_basics(data)
        if self.path == "/api/meeting/material":
            return self.handle_material(data)
        if self.path == "/api/meeting/download":
            return self.download_materials(data)
        if self.path=="/api/meeting/match":
            text=str(data.get("text",""))[:2000]
            meetings=data.get("meetings",[])
            if not isinstance(meetings,list):meetings=[]
            candidates=[]
            for item in meetings[:40]:
                if not isinstance(item,dict):continue
                source_facts=item.get("facts",{}) if isinstance(item.get("facts"),dict) else {}
                facts={str(k):str(v)[:240] for k,v in source_facts.items() if k in {"purpose","date","time","location","attendee_count","agenda"}}
                recent=item.get("messages",[]) if isinstance(item.get("messages"),list) else []
                recent=[str(m)[:240] for m in recent[-8:] if isinstance(m,str)]
                candidates.append({"id":str(item.get("id",""))[:100],"name":str(item.get("name",""))[:200],"title":str(item.get("title",""))[:200],"facts":facts,"recent_user_messages":recent})
            if not candidates or not API_KEY:return self.send_json(200,{"match_id":None,"clarify":False})
            matcher="判断新需求是否是对已有会议的继续沟通。相同会议名称/主题/日期，即使参会人数、时间、地点等信息改变，也应匹配原会议；不得因人数变更而新建会议。若输入很笼统或无法确认是哪场会议，应要求用户从列表选择，返回clarify=true。若能确定是新会议，返回clarify=false且match_id=null。只能从候选列表中选择id，绝不编造id。只返回JSON：{\"match_id\":null或候选id,\"confidence\":0到1,\"clarify\":true或false}。候选数据："+json.dumps(candidates,ensure_ascii=False)
            answer=llm([{"role":"system","content":matcher},{"role":"user","content":text}],180)
            result=parse_json_object(answer) or {}
            match_id=result.get("match_id")
            confidence=result.get("confidence",0)
            try:confidence=float(confidence)
            except (TypeError,ValueError):confidence=0
            valid_ids={x["id"] for x in candidates}
            possible_match=match_id in valid_ids
            if not possible_match or confidence<0.72:match_id=None
            clarify=(bool(result.get("clarify")) or (possible_match and confidence<0.72)) and match_id is None
            return self.send_json(200,{"match_id":match_id,"clarify":clarify,"confidence":confidence})
        if self.path=="/api/ai/workbench-intent":
            text=str(data.get("text", ""))[:4000]
            turns = data.get("messages", [])
            clean = []
            if isinstance(turns, list):
                for item in turns[-16:]:
                    if not isinstance(item, dict):
                        continue
                    role = item.get("role")
                    content = item.get("text", item.get("content", ""))
                    if role not in ("user", "assistant") or not isinstance(content, str):
                        continue
                    if role == "assistant" and content == "暂未连接到模型服务，请稍后再试。":
                        continue
                    clean.append({"role": role, "content": content[:2500]})
            if clean and clean[-1]["role"] == "user" and clean[-1]["content"] == text[:2500]:
                clean[-1]["content"] = text
            else:
                clean.append({"role": "user", "content": text})
            shared=clean_shared_memory(data.get("shared_memory"))
            system=BASE_PERSONA+"\n\n首页综合助手任务："+HOME_AGENT_TASK+"\n\n用户共享记忆（仅作背景参考，以用户当前明确表达为准）："+json.dumps(shared,ensure_ascii=False)[:2500]
            answer=llm([{"role":"system","content":system}]+clean,500)
            result=parse_json_object(answer) or {}
            candidate=result.get("intent")
            try:confidence=float(result.get("confidence",0))
            except (TypeError,ValueError):confidence=0
            if candidate not in ASSISTANTS or confidence<0.72:candidate=""
            reply=result.get("reply")
            if not isinstance(reply,str) or not reply.strip():
                reply="好的，我陪您一起梳理。您眼下最希望先解决的是什么？"
            summary=result.get("handoff_summary","")
            return self.send_json(200,{"intent":candidate,"confidence":confidence,"reply":reply[:2000],"handoff_summary":str(summary)[:1800],"shared_memory_patch":clean_memory_patch(result.get("shared_memory_patch"))})
        if self.path=="/api/ai/chat":
            key=data.get("assistant");messages=data.get("messages",[])
            if key not in ASSISTANTS:return self.send_json(400,{"error":"助手类型无效"})
            if not isinstance(messages,list) or not messages:return self.send_json(400,{"error":"请先输入需求"})
            system=BASE_PERSONA+"\n\n当前工作区："+ASSISTANTS[key]+"。\n任务要求："+ASSISTANT_TASKS[key]
            if key == "meeting":
                system += "\n\n必须输出顶层 meeting 对象。凡用户明确提供的主题、日期、时间和会议室，全部填入 meeting.facts；仅在 reply 里复述不会保存资料。\n"
            else:
                system += "\n\n输出要求：只输出JSON对象，字段为reply（自然、礼貌的中文回复）、artifact（可直接审阅的工作成果，没有独立成果时与reply相同）、shared_memory_patch（对象，包含facts与preferences两个字符串数组）。\n"
            system+="共享记忆只记录用户明确表达且对五位助手未来服务有复用价值的非敏感背景或偏好；不推断用户职务/身份，不记录密钥、证件、私人联系方式、完整文件内容等敏感信息。没有合适内容时数组留空。"
            shared=clean_shared_memory(data.get("shared_memory"))
            system+="\n\n用户共享记忆（供五位助手共同参考；最新明确表达优先）：\n"+json.dumps(shared,ensure_ascii=False)[:2500]
            handoff=data.get("home_handoff")
            if isinstance(handoff,str) and handoff.strip():system+="\n\n首页综合助手交接摘要（已由用户在本次沟通中提供）：\n"+handoff[:1800]
            meeting_memory=data.get("meeting_memory")
            meeting_day = datetime.now(ZoneInfo("Asia/Shanghai")).date()
            if key=="meeting" and isinstance(meeting_memory,dict):
                profile=clean_meeting_profile(meeting_memory.get("profile"))
                try:
                    meeting_day = date.fromisoformat(clean_text(meeting_memory.get("today"), 10))
                except ValueError:
                    pass
                memory = {
                    **profile,
                    "phase": clean_text(meeting_memory.get("phase"), 100),
                    "current_material": clean_text(meeting_memory.get("current_material"), 50),
                    "completed_materials": list(clean_materials(meeting_memory.get("materials"))),
                    "today": meeting_day.isoformat(),
                }
                system += "\n\n本次会议档案，以最新明确指示为准：\n" + json.dumps(memory, ensure_ascii=False)
            clean=[]
            for m in messages[-30:]:
                if not isinstance(m,dict):continue
                role=m.get("role");content=m.get("text","")
                if role in ("user","assistant") and isinstance(content,str):clean.append({"role":role,"content":content[:6000]})
            if not clean:return self.send_json(400,{"error":"对话内容为空"})
            model_messages = [{"role": "system", "content": system}] + clean
            if key == "meeting":
                latest = next((item["content"] for item in reversed(clean) if item["role"] == "user"), "")
                explicit_facts = extract_meeting_basics(latest, meeting_day)
                try:
                    reply = llm(model_messages, required_json_key="meeting")
                    result = parse_json_object(reply) or {}
                except ModelServiceError:
                    if not explicit_facts:
                        raise
                    result = {"meeting": {"facts": explicit_facts}, "reply": "已将能明确识别的会议基本信息填到右侧。其他内容暂未提取，您可继续补充或核对。"}
                update = result.get("meeting")
                update = update if isinstance(update, dict) else {}
                profile = clean_meeting_profile(update)
                patch = {
                    "facts": {**profile["facts"], **explicit_facts},
                    "participants": profile["participants"] if isinstance(update.get("participants"), list) else None,
                    "meal": profile["meal"] if isinstance(update.get("meal"), dict) else None,
                    "action": update.get("action") if update.get("action") in ("start", "resume") else "",
                    "tent_language": update.get("tent_language") if update.get("tent_language") in ("zh", "zh-en") else "",
                }
                revision = update.get("revision")
                if isinstance(revision, dict) and revision.get("key") in MATERIALS:
                    instruction = clean_text(revision.get("instruction"), 2400)
                    if instruction:
                        patch["revision"] = {"key": revision["key"], "instruction": instruction}
                return self.send_json(200, {
                    "reply": clean_text(result.get("reply"), 2000) or "请您再补充一下，我会接着为您整理。",
                    "meeting": patch,
                    "shared_memory_patch": clean_memory_patch(result.get("shared_memory_patch")),
                })
            reply = llm(model_messages)
            result=parse_json_object(reply) or {}
            text_reply=result.get("reply")
            if not isinstance(text_reply,str) or not text_reply.strip():text_reply=reply
            artifact=result.get("artifact")
            if not isinstance(artifact,str) or not artifact.strip():artifact=text_reply
            return self.send_json(200,{"reply":text_reply[:12000],"artifact":artifact[:12000],"shared_memory_patch":clean_memory_patch(result.get("shared_memory_patch"))})
        return self.send_json(404,{"error":"未找到接口"})

if __name__=="__main__":
    print("综智助手 listening on :%s | model=%s | key=%s"%(PORT,MODEL,"configured" if API_KEY else "missing"))
    ThreadingHTTPServer(("0.0.0.0",PORT),Handler).serve_forever()
