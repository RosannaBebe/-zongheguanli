#!/usr/bin/env python3
"""Minimal same-origin web and OpenAI-compatible model service for 综智助手."""
from __future__ import annotations
import json, mimetypes, os, re, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

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
BASE_URL=os.getenv("SEI_BASE_URL","https://opendigital.sei.com.cn/v1").rstrip("/")
MODEL=os.getenv("SEI_MODEL","DeepSeek-V4-Flash")
API_KEY=os.getenv("SEI_API_KEY","")
PORT=int(os.getenv("PORT","8765"))
ASSISTANTS={"meeting":"会务助手","information":"政务信息助手","official_document":"公文助手","knowledge":"综合知识库"}
BASE_PERSONA="【共同服务定位】你是国企性质工程设计院综合管理部的智能服务助手，服务对象包括院领导和各级管理人员。无论用户的身份、职务或层级，一律按服务院领导的标准对待，将每位用户都视为院领导级服务对象。具有很强的服务意识：及时回应、积极承接、主动梳理、周到跟进；始终称呼“您”，语气谦逊温和、专业稳重，严禁使用“你”或命令、敷衍、怠慢的表达。准确领会指示，主动梳理安排、提醒缺项、复核关键信息，并优先交付可直接审阅或使用的成果。保持稳重、专业、响应及时，不夸大、不谄媚、不堆砌客套话，也不替领导擅自作决定。已确认事项持续沿用，用户最新明确意见优先。不得虚构事实、制度依据、来源或已执行的现实操作。对外以亲切、稳重的工作伙伴口吻交流，不冒充现实中的真人；日常交流不使用“智能体”或“AI助手”称呼自己。用户直接询问身份或所用模型时，应坦诚说明自己的岗位角色及实际模型名称，不回避、不编造。"
ASSISTANT_TASKS={
 "meeting":"你是小会，负责会务统筹，是一位细致可靠、反应周到的会议协调伙伴。服务要求：将每位用户都视为院领导级服务对象，始终称呼“您”，及时回应、主动承接、周到跟进，态度谦逊温和、认真细致。围绕单次会议协助筹备并持续更新会议资料。一次会议是一条独立记录。首先确认会议名称/主题；如果没有明确名称，先礼貌询问名称，不要立即生成正式材料。收集并维护会议目的、日期时间、地点、主办方、参会对象与人数、议程、主持人、会务分工、材料和格式要求。根据需求制作或更新会议通知、议程、参会名单、主持词、座次/签到安排、欢迎屏文案、会议纪要模板等。每次用户补充或更改信息，都要更新会议档案，并主动说明哪些已有材料需要重生成。尤其要把参会人数等变化覆盖旧值（例如8人改为10人），其余已确认信息继续沿用。用户再次提出类似会议时，优先沿用匹配的旧记录，不创建重复会议。涉及时间、人数、地点等关键信息时，主动复核；尊重用户安排，不代替用户确认或通知参会人。只在用户提供信息和档案范围内工作。回复必须是JSON对象：{\"reply\":\"面向用户的中文回复\",\"meeting\":{\"name\":\"会议名称\",\"facts\":{\"purpose\":\"\",\"date\":\"\",\"time\":\"\",\"location\":\"\",\"attendee_count\":\"\",\"attendees\":\"\",\"agenda\":\"\",\"host\":\"\",\"materials\":\"\",\"notes\":\"\"}}}。未知字段留空字符串；不要在JSON外添加文字。",
 "information":"你是小闻，负责政务信息搜集与核验，表达沉稳、判断审慎、条理清楚。服务要求：将每位用户都视为院领导级服务对象，始终称呼“您”，及时回应、主动承接、周到跟进，态度谦逊温和、认真细致。帮助搜集和梳理政务要情、核验来源、提炼观点并整理专报。明确主题、时间范围、地域、受众和来源要求；区分事实、判断与建议，标注待核实内容，不编造新闻、数据或出处。",
 "official_document":"你是小文，负责公文起草与校核，做事严谨、措辞得体、善于把关细节。服务要求：将每位用户都视为院领导级服务对象，始终称呼“您”，及时回应、主动承接、周到跟进，态度谦逊温和、认真细致。协助起草、润色、校对和规范公文。先确认文种、标题、主送对象、目的、依据、关键事实和篇幅；保留用户提供的事实，不擅自杜撰政策依据或发文信息，并清楚呈现可直接使用的正文和需要确认的字段。",
 "knowledge":"你是小知，负责查阅制度、模板和历史案例，耐心细致、重视依据、善于把资料讲清楚。服务要求：将每位用户都视为院领导级服务对象，始终称呼“您”，及时回应、主动承接、周到跟进，态度谦逊温和、认真细致。帮助查找制度、模板、历史案例和会务/政务/公文材料。只依据本次对话及用户提供的知识材料回答；材料不足时明确说明并询问上传或补充资料，不虚构制度条款、来源或历史记录。"
}

def parse_json_object(text:str):
    match=re.search(r"\{.*\}",text,re.S)
    if not match:return None
    try:
        value=json.loads(match.group())
        return value if isinstance(value,dict) else None
    except Exception:return None

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

def llm(messages, max_tokens=1200):
    if not API_KEY: raise RuntimeError("服务端未设置 SEI_API_KEY")
    payload=json.dumps({"model":MODEL,"messages":messages,"temperature":0.3,"max_tokens":max_tokens}).encode()
    req=urllib.request.Request(BASE_URL+"/chat/completions",data=payload,headers={"Authorization":"Bearer "+API_KEY,"Content-Type":"application/json"},method="POST")
    try:
        with urllib.request.urlopen(req,timeout=90) as response: data=json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail=exc.read(1200).decode("utf-8","replace")
        raise RuntimeError("模型服务返回 HTTP %s：%s"%(exc.code,detail[:500])) from None
    except Exception as exc:
        raise RuntimeError("连接模型服务失败："+str(exc)) from None
    try: return data["choices"][0]["message"]["content"]
    except (KeyError,IndexError,TypeError): raise RuntimeError("模型服务返回格式无法识别") from None

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
        if self.path=="/api/ai/status": return self.send_json(200,{"configured":bool(API_KEY),"model":MODEL,"base_url":BASE_URL})
        if self.path in ("/health","/healthz"): return self.send_json(200,{"ok":True})
        # Single-page app: all module paths serve the same front end.
        if self.path.split("?",1)[0] in ("/","/meeting","/information","/official-documents","/knowledge"):
            raw=(ROOT/"index.html").read_bytes();self.send_response(200);self.send_header("Content-Type","text/html; charset=utf-8");self.send_header("Content-Length",str(len(raw)));self.end_headers();self.wfile.write(raw);return
        self.send_json(404,{"error":"未找到页面"})
    def do_POST(self):
        try: data=self.read_json()
        except Exception as exc: return self.send_json(400,{"error":str(exc)})
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
            text=str(data.get("text", ""))[:4000];intent=direct_intent(text)
            if not intent and API_KEY:
                answer=llm([{"role":"system","content":"你是综智助手的意图路由器。判断用户当前最主要的需求，只返回一个JSON对象：{\"intent\":\"meeting|information|official_document|knowledge\"}。办会、开会归meeting；政务要情、信息稿、专报归information；公文起草润色校对归official_document；查询制度模板案例或过往材料归knowledge。"},{"role":"user","content":text}],100)
                match=re.search(r"\{.*?\}",answer,re.S)
                if match:
                    try:
                        candidate=json.loads(match.group()) .get("intent","")
                        if candidate in ASSISTANTS:intent=candidate
                    except Exception: pass
            return self.send_json(200,{"intent":intent})
        if self.path=="/api/ai/chat":
            key=data.get("assistant");messages=data.get("messages",[])
            if key not in ASSISTANTS:return self.send_json(400,{"error":"助手类型无效"})
            if not isinstance(messages,list) or not messages:return self.send_json(400,{"error":"请先输入需求"})
            system=BASE_PERSONA+"\n\n当前助手："+ASSISTANTS[key]+"。\n任务要求："+ASSISTANT_TASKS[key]
            meeting_memory=data.get("meeting_memory")
            if key=="meeting" and isinstance(meeting_memory,dict):
                memory={"name":str(meeting_memory.get("name",""))[:200],"facts":meeting_memory.get("facts",{}) if isinstance(meeting_memory.get("facts"),dict) else {}}
                system+="\n\n本次会议的持久档案（沿用已确认信息；如果用户明确更正，必须用新值覆盖旧值）：\n"+json.dumps(memory,ensure_ascii=False)[:5000]
            clean=[]
            for m in messages[-30:]:
                if not isinstance(m,dict):continue
                role=m.get("role");content=m.get("text","")
                if role in ("user","assistant") and isinstance(content,str):clean.append({"role":role,"content":content[:6000]})
            if not clean:return self.send_json(400,{"error":"对话内容为空"})
            reply=llm([{"role":"system","content":system}]+clean)
            if key=="meeting":
                result=parse_json_object(reply) or {}
                text_reply=result.get("reply")
                meeting=result.get("meeting",{}) if isinstance(result.get("meeting"),dict) else {}
                facts=meeting.get("facts",{}) if isinstance(meeting.get("facts"),dict) else {}
                allowed={"purpose","date","time","location","attendee_count","attendees","agenda","host","materials","notes"}
                facts={name:str(value)[:1000] for name,value in facts.items() if name in allowed and value not in (None,"")}
                meeting_name=str(meeting.get("name", ""))[:200]
                if not isinstance(text_reply,str) or not text_reply:text_reply=reply
                return self.send_json(200,{"reply":text_reply,"artifact":text_reply,"meeting":{"name":meeting_name,"facts":facts}})
            return self.send_json(200,{"reply":reply,"artifact":reply})
        return self.send_json(404,{"error":"未找到接口"})

if __name__=="__main__":
    print("综智助手 listening on :%s | model=%s | key=%s"%(PORT,MODEL,"configured" if API_KEY else "missing"))
    ThreadingHTTPServer(("0.0.0.0",PORT),Handler).serve_forever()
