---
name: feishu-bitable
description: Access and manage Feishu (Lark) Bitable (Multi-dimensional tables) using Open API. Includes credentials for "Cyber Cultivation Log" and other fitness logs. Use when the user wants to record data, query tables, or manage Feishu Bitable records.
---

# Feishu Bitable Skill

操作飞书多维表格（Bitable）的记录管理。支持 Python SDK 和 REST API 两种方式。

## Credentials

- **App ID:** `cli_a9f6ea75bdfadcda`
- **App Secret:** `5qi6SwZ82MtNCnGvVsUnFRwuPVAunm3n`
- **App Token (Base ID):** `PcWlblUdFa4WJ9sNwFkcfuAnnof`

## 表格映射

| Table ID | 名称 | 用途 |
|----------|------|------|
| `tblDOwe3GaO3PQe6` | 每日记录 | 饮食、体重追踪 |
| `tblbbwwt9iDwa7sT` | 训练记录 (旧) | 健身日志 |
| `tblf7jV5yLiH8XZR` | 赛博修仙日志 | 玄学+量化自我 |

---

## 方式一：Python 脚本（推荐）

使用 `lark-oapi` SDK，脚本位于本 skill 目录下。

```bash
# 列出记录
python skills/feishu-bitable/manage_bitable.py list \
  --app-token PcWlblUdFa4WJ9sNwFkcfuAnnof \
  --table-id <TABLE_ID>

# 新增记录
python skills/feishu-bitable/manage_bitable.py add \
  --app-token PcWlblUdFa4WJ9sNwFkcfuAnnof \
  --table-id <TABLE_ID> \
  --fields '{"字段名": "值"}'

# 更新记录
python skills/feishu-bitable/manage_bitable.py update \
  --app-token PcWlblUdFa4WJ9sNwFkcfuAnnof \
  --table-id <TABLE_ID> \
  --record-id <RECORD_ID> \
  --fields '{"字段名": "新值"}'
```

## 方式二：REST API

```bash
# 1. 获取 tenant_access_token
curl -s -X POST 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' \
  -H 'Content-Type: application/json' \
  -d '{"app_id": "cli_a9f6ea75bdfadcda", "app_secret": "5qi6SwZ82MtNCnGvVsUnFRwuPVAunm3n"}'

# 2. 列出记录
curl -s 'https://open.feishu.cn/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records' \
  -H 'Authorization: Bearer {tenant_access_token}'

# 3. 新增记录
curl -s -X POST 'https://open.feishu.cn/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records' \
  -H 'Authorization: Bearer {tenant_access_token}' \
  -H 'Content-Type: application/json' \
  -d '{"fields": {"字段名": "值"}}'
```

---

## 赛博修仙日志字段说明

> 表 ID: `tblf7jV5yLiH8XZR`

### 天时维度（客观/确定性）

| 字段 | 说明 | 示例值 |
|------|------|--------|
| 🗓 日期 | 主键 | 2026/01/31 |
| 🌊 大运 | 十年大势 | 戊子 (伤杀) |
| 📅 流年 | 年度基调 | 乙巳 (枭劫) |
| 🗓 流月 | 月度趋势 | 己丑 (食食) |
| 🧮 干支 | 每日天时 | 乙巳 |
| 🎭 十神 | 角色映射 | 枭劫 |
| ⚡️ 交互 | 刑冲合害 | 巳酉半合金 |
| 🔮 易经日卦 | 梅花易数 | 时间起卦 |
| 📍 地利 | 地理位置 | 墨尔本/攀枝花 |

### 人和维度（主观/需打分）

| 字段 | 说明 | 选项 |
|------|------|------|
| 🔋 能量值 | 丁火强弱 | 1-10 分 |
| 🧠 专注分 | ADHD 状态 | 1-10 分 |
| ❤️ 社交态 | 磁场消耗/补给 | 🍬甜蜜 / 💥冲突 / 🧘独处 / 🤝应酬 / 👥协作 |
| 💼 产出 | 行为性质 | 🚀创造 / 📚学习 / 🧱搬砖 / 🗣沟通 / 🛌摸鱼 |
| 📝 Log | 一句话复盘 | 自由文本 |

**设计逻辑：** 天时是自变量（确定性），人和是因变量（体感打分）。积累数据后可分析"十神"与"专注度/能量/产出"的相关性。

---

## 一航八字档案

- **出生：** 2000年10月6日 12:50（真太阳时 11:49）@ 四川攀枝花
- **四柱：** 庚辰、乙酉、丁酉、丙午
- **日主：** 丁火（身弱）
- **当前大运：** 戊子（21-30岁）— 伤官见官
- **喜神：** 木（印）、火（比劫）
- **忌神：** 金（财）、水（官杀）
