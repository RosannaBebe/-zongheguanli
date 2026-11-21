# 综智助手

基于首页风格重构的轻量工作台，支持意图识别、会务/政务信息/公文/知识库四类助手、成果展示和本地历史对话。模型调用经 Python 服务端转发，浏览器和 GitHub 仓库都不会收到 API Key。

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
