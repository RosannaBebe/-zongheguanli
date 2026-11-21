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

def direct_intent(text:str)->str:
    # Explicit assistant requests always win. Lookup language then routes historical material to the knowledge base.
    if re.search(r"打开.{0,8}会务助手|进入.{0,8}会务助手|会务助手",text): return "meeting"
    if re.search(r"打开.{0,10}(政务信息助手|信息助手)|进入.{0,10}(政务信息助手|信息助手)|政务信息助手",text): return "information"
    if re.search(r"打开.{0,8}公文助手|进入.{0,8}公文助手|公文助手",text): return "official_document"
    if re.search(r"打开.{0,10}(综合知识库|知识库)|进入.{0,10}(综合知识库|知识库)|综合知识库",text): return "knowledge"
    if re.search(r"(查询|查找|查阅|搜一下|历史|以前|制度|模板|案例)",text) and re.search(r"(会议|会务|公文|信息|资料|要情|制度|模板|案例)",text): return "knowledge"
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
            system=("你是综智助手中的%s，使用简洁、清楚的中文与用户协作。先理解目标，缺少关键信息时提出具体问题；能完成的工作直接给出草稿、清单或结果。不要声称已执行现实世界操作。涉及知识库时，只能基于用户提供的材料回答，不得伪造制度、来源或历史记录。将完整可交付内容直接写在答复中。"%ASSISTANTS[key])
            clean=[]
            for m in messages[-20:]:
                role=m.get("role");content=m.get("text","")
                if role in ("user","assistant") and isinstance(content,str):clean.append({"role":role,"content":content[:6000]})
            if not clean:return self.send_json(400,{"error":"对话内容为空"})
            reply=llm([{"role":"system","content":system}]+clean)
            return self.send_json(200,{"reply":reply,"artifact":reply})
        return self.send_json(404,{"error":"未找到接口"})

if __name__=="__main__":
    print("综智助手 listening on :%s | model=%s | key=%s"%(PORT,MODEL,"configured" if API_KEY else "missing"))
    ThreadingHTTPServer(("0.0.0.0",PORT),Handler).serve_forever()
