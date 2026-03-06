# Transit Planner Skill

墨尔本公交/火车/电车实时查询。用户说"去学校"、"怎么去XX"、"查公交"时触发。

## ⚡ 快速查询（直接复制跑）

```bash
# 查公交路线（从A到B，departure_time=now 表示现在出发）
/Users/yihang/have_fun/openclaw/skills/transit-planner/scripts/transit-query.sh "起点地址" "终点地址"

# 用别名（home/monash/city/chadstone）
/Users/yihang/have_fun/openclaw/skills/transit-planner/scripts/transit-query.sh home monash
```

## 🗺️ 地点别名

定义在 `locations.json`，当前支持：
- `home` = 213 Normanby Road, Notting Hill VIC 3168（一航的家）
- `monash` = Monash University Clayton Campus（学校）
- `city` = Flinders Street Station, Melbourne（市区）

**⚠️ 重要：一航说"去学校"/"去 Monash" = 查公交路线，不要给步行方案（他知道怎么走）。**

## 🔑 API Keys

- **Google Maps Directions API**: 已配置，key 存在脚本环境中
  - `AIzaSyC-arzSpJMuESRa5pV6CmV3J0uJr_8Ht8Y`
- **PTV Timetable API**: 已申请，等回复中（devid + key）
  - 拿到后写入 `.env` 并取消 `transit-query.sh` 中 PTV 部分的注释

## 📋 输出规则

1. **只给公交/火车/电车方案**，不要给纯步行方案（除非用户明确问走路多久）
2. 列出最近 3-5 班车，格式：时间 + 线路 + 站名 + 总耗时
3. 如果 PTV 有实时数据，标注是否晚点
4. 飞书渠道：不用 markdown 表格，用纯文本列表

## 🛠️ 故障排查

- Google Maps 返回纯步行 → 目的地太近，但**仍然要查公交**，加 `transit_mode=bus` 参数
- PTV 未配置 → 只用 Google Maps，提示"PTV 实时数据暂不可用"
- 两个都失败 → 用浏览器打开 Google Maps 网页版查
