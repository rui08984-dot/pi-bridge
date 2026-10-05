#!/usr/bin/env bash
# 直接问引擎：带 tools 参数发一个 OpenAI 格式请求，看返回里有没有结构化 tool_calls。
# 这能一刀切开「引擎不支持」 vs 「Pi 侧接法问题」。
#
# 用法：PORT=<端口> MODEL=<模型id> [OUT_FILE=<探测写入目标>] bash tests/engine-probe.sh
#   例：PORT=8000 MODEL=my-model bash tests/engine-probe.sh
PORT="${PORT:-${1:-8000}}"
MODEL="${MODEL:-${2:-local-model}}"
OUT_FILE="${OUT_FILE:-engine_probe_out.txt}"

echo "探测 http://127.0.0.1:$PORT  模型 $MODEL"

python3 - <<PY 2>/dev/null || python - <<PY
import json, urllib.request, sys
req = {
  "model": "$MODEL",
  "messages": [{"role": "user", "content": "用 write 工具把 hello 写入 $OUT_FILE"}],
  "tools": [{
    "type": "function",
    "function": {
      "name": "write",
      "description": "写入文件",
      "parameters": {
        "type": "object",
        "properties": {
          "path": {"type": "string", "description": "文件路径"},
          "content": {"type": "string", "description": "内容"}
        },
        "required": ["path", "content"]
      }
    }
  }],
  "tool_choice": "auto",
  "max_tokens": 2048,
  "temperature": 0.2
}
r = urllib.request.Request("http://127.0.0.1:$PORT/v1/chat/completions",
    data=json.dumps(req).encode(),
    headers={"Content-Type": "application/json", "Authorization": "Bearer local"})
try:
    d = json.load(urllib.request.urlopen(r, timeout=300))
except Exception as e:
    print("❌ 请求失败:", str(e)[:300]); sys.exit(1)

if "error" in d:
    print("❌ 引擎报错:", json.dumps(d["error"], ensure_ascii=False)[:400]); sys.exit(1)

ch = (d.get("choices") or [{}])[0]
msg = ch.get("message", {})
print("finish_reason:", ch.get("finish_reason"))
print("有 tool_calls 字段:", bool(msg.get("tool_calls")))
if msg.get("tool_calls"):
    print("✅ 结构化 tool_calls:")
    print(json.dumps(msg["tool_calls"], ensure_ascii=False, indent=1)[:800])
c = msg.get("content") or ""
print("content 长度:", len(c))
print("content 前 500 字:\n" + c[:500])
if "<tool_call>" in c or "parameter=" in c:
    print("⚠️ 引擎把工具调用吐成了纯文本")
zw = [hex(ord(x)) for x in c[:200] if ord(x) in (0x200b, 0x200c, 0xfeff, 0x2060)]
if zw:
    print("⚠️ content 前 200 字含零宽字符:", set(zw))
PY
