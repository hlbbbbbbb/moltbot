# 预判模板

用于填写飞书表格的"📝 复盘_Log"字段（明日预判部分）。

---

【劳伦斯预判】
**天时：** {ganzhi}日（{shishen}）
**交互：** {interaction}
**能量预测：** {energy_prediction}±1 / 10
**适合：** {suitable_activities}
**注意：** {warnings}

{personalized_advice}

【待填】稍后打分～

---

## 生成逻辑

### 1. 天时与十神
- 从 `ganzhi_anchor.json` 计算干支
- 从 `shishen_map.json` 查询十神
- 从 `personal_patterns.json` 查询交互（刑冲合害）

### 2. 能量预测
```python
base = 5
bonus = personal_patterns["energy_formula"]["shishen_bonus"][shishen]
adjust = personal_patterns["energy_formula"]["interaction_adjust"][interaction_type]
energy_prediction = base + bonus + adjust
```

### 3. 适合/注意事项
根据十神特性 + 个性化规律生成：

**劫财/比肩：**
- 适合：冲刺大项目、团队协作、借力发力
- 注意：容易冲动，遇摩擦时冷静

**伤官/偏财：**
- 适合：创意输出、死磕难题、突破性工作
- 注意：情绪波动大，深夜易emo

**印星日：**
- 适合：学习输入、充电回血、规划思考
- 注意：不爆发，别期待高产

**食神（自刑）：**
- 适合：摸鱼、放松、低压力任务
- 注意：别盯数据/结果，易完美主义焦虑

### 4. 个性化建议
基于 `learned_patterns` 生成针对性建议。

---

## 填写示例

【劳伦斯预判】
**天时：** 辛亥日（正财/正官）
**交互：** 亥酉暗拱木（生印）
**能量预测：** 6±1 / 10
**适合：** 学习输入、规划整理、稳扎稳打
**注意：** 正官透出会带责任感/压力，别过度自我要求

💡 这是个"补血日"，亥酉暗拱木生印，适合充电回血。官星虽带压力，但印星护身，适合学习思考而非硬拼产出。放松心态，稳步推进即可～

【待填】稍后打分～
