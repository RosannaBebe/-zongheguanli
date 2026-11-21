# 综智助手

基于首页风格重构的轻量工作台，支持意图识别、会务/政务信息/公文/知识库四类助手、成果展示和本地历史对话。模型调用经 Python 服务端转发，浏览器和 GitHub 仓库都不会收到 API Key。

## 助手对话与记忆

二级工作区左侧显示当前助手自己的历史列表；列表按助手类型分开。会议助手按“一场会议一条记录”管理。首次沟通会优先确认会议名称，后续把会议档案和最近对话一同发给模型；新请求会先尝试匹配已有会议，像参会人数从 8 人改为 10 人这样的变更会接续原记录。对话和会议档案保存在当前浏览器的 localStorage 中，因此同一浏览器可继续工作；不同设备之间暂不共享。

四个助手共用同一份 persona 规则（专业、清楚、保留已确认信息并以用户最新修订为准），各自使用独立任务提示词。会议助手的 prompt 管理会务筹备、会议名称和会议事实档案；政务信息、公文和知识库助手使用各自的任务边界。

共同 persona 按国企工程设计院综合管理部的领导服务场景设定：对所有用户保持尊重、礼貌、稳妥、主动和周到，称呼使用“您”，积极复核重点并提供可直接审阅的成果；不使用随意或怠慢的措辞，也不以浮夸恭维代替专业服务。

GitHub 的 `main` 保存当前部署版本。每次发布前会在 `versions/` 下创建指向当时提交的版本分支，后续发布不会删除这些历史快照。

## 部署到 Render

仓库包含 `render.yaml`，可按以下步骤从 GitHub 创建服务：

1. 在 Render 选择 **New → Blueprint**，连接 GitHub 并选择 `RosannaBebe/-zongheguanli`。
2. Render 读取 Blueprint 后，会要求填写 `SEI_API_KEY`。将模型提供方签发的 Key 填入该 Secret 字段；不要把它写入代码或提交到 GitHub。
3. 创建服务并等待部署完成。Render 会提供一个 `https://…onrender.com` 地址，打开即可使用。
4. 如之后需要更换密钥，在 Render 服务的 **Environment** 中修改 `SEI_API_KEY` 并重新部署。

`SEI_BASE_URL` 和 `SEI_MODEL` 已在部署配置中设为模型服务地址和 `DeepSeek-V4-Flash`。模型密钥保存在 Render 服务端环境变量中。免费实例可能在空闲后休眠，首次访问会需要等待服务唤醒。

## 本地运行

1. 复制 `.env.example` 为 `.env`，填入 `SEI_API_KEY`。
2. 运行 `python3 server.py`。
3. 打开 `http://127.0.0.1:8765`。

## 环境变量

- `SEI_BASE_URL`：默认 `https://opendigital.sei.com.cn/v1`
- `SEI_MODEL`：默认 `DeepSeek-V4-Flash`
- `SEI_API_KEY`：服务端 API Key
- `PORT`：默认 `8765`

`.env` 被 `.gitignore` 排除。部署平台只需配置 `SEI_API_KEY`；请勿提交真实密钥。

## 接口

- `GET /api/ai/status`
- `POST /api/ai/workbench-intent`
- `POST /api/ai/chat`
- `GET /health`
