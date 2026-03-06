---
name: monash-learning
description: Access and browse 一航's Monash University learning platform (Moodle) to check course content, assignments, deadlines, and weekly tasks. Use when the user asks about their university courses, upcoming assignments, what to do this week, FIT5120/FIT5122/FIT5231 tasks, or anything related to Monash study. Requires Chrome browser relay (profile=chrome) — the user is always logged in.
---

# Monash Learning Skill

一航 is a Master of AI student at Monash University. Use the Chrome browser relay to access their Moodle and report on courses, tasks, and deadlines.

## URLs

### Moodle (学习平台)
- **Dashboard (all DDLs):** https://learning.monash.edu/my/
- **FIT5120** Industry Experience Studio Project: https://learning.monash.edu/course/view.php?id=41056
- **FIT5122** Professional Practice: https://learning.monash.edu/course/view.php?id=41057
- **FIT5231** Indigenous Data Sovereignty: https://learning.monash.edu/course/view.php?id=41065

### Ed Discussion (Q&A / 公告)
- **Ed Dashboard:** https://edstem.org/au/dashboard
- **FIT5231 Ed:** https://edstem.org/au/courses/34342/discussion
- FIT5120 / FIT5122 暂无 Ed 课程（截至 2026-03-01）

## Workflow

1. Open the target URL with `browser(action=open, profile=chrome, targetUrl=...)`
2. Take a screenshot to confirm it loaded and the user is logged in
3. Use `browser(action=snapshot)` to extract structured content
4. Navigate into specific course/activity pages as needed
5. Report findings clearly — deadlines, task descriptions, what to do next

## Tips

- **优先用 `profile=clawd`**（已于 2026-03-01 登录 Monash，session 持久保存，无需 attach tab）
- `profile=chrome` 需要用户每次 attach tab，不推荐用于 Moodle
- If the tab gets detached mid-session, use `browser(action=tabs, profile=clawd)` to find the active tab, or re-open the URL
- **同一个已登录的 tab 内导航**（navigate 而不是 open 新 tab），否则新 tab 会触发 Okta 二次验证

## 登录方法（Session 过期时）

Monash 使用 Okta SSO，Lawrence 可以自动完成大部分登录，只需一航配合 MFA 推送确认。

### 自动登录流程：
1. `browser(action=open, profile=clawd, targetUrl="https://learning.monash.edu/my/")`
2. 截图确认是否跳到 Okta 登录页
3. 如果跳了，Lawrence 自己操作：
   - 清空邮箱框，输入 `yhua0298@student.monash.edu`
   - 勾选"保持登录"
   - 点"下一步"
   - 输入密码（见 MEMORY.md）
   - 点"验证"
4. MFA 页面：**选"获取推送通知"**（一航偏好，不要用验证码）
5. 截图读取屏幕上的数字，发给一航
6. 一航在手机 Okta Verify 上点对应数字完成验证
7. 等待几秒后确认登录成功，navigate 到目标页面

### 注意事项：
- checkbox 可能不能直接 click，改点旁边的文字 label
- 登录成功后在**同一个 tab 内 navigate**，不要 open 新 tab（会触发二次验证）
- 如果 clawd 浏览器服务没响应，先 `gateway restart` 再试
- Dashboard shows the **Timeline** (upcoming DDLs) and **Calendar** — great for quick overview
- Course pages show weekly sections with readings, quizzes, and assignments
- For detailed assignment instructions, click through to the assignment/quiz page

## Current Semester: S1 2026

See `references/courses.md` for course details, known DDLs, and assignment descriptions.
