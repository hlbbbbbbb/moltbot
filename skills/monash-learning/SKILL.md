---
name: monash-learning
description: Access and browse 一航's Monash University learning platform (Moodle) to check course content, assignments, deadlines, and weekly tasks. Use when the user asks about their university courses, upcoming assignments, what to do this week, FIT5120/FIT5122/FIT5231 tasks, or anything related to Monash study. Requires Chrome browser relay (profile=chrome) — the user is always logged in.
---

# Monash Learning Skill

一航 is a Master of AI student at Monash University. Use the Chrome browser relay to access their Moodle and report on courses, tasks, and deadlines.

## URLs

- **Dashboard (all DDLs):** https://learning.monash.edu/my/
- **FIT5120** Industry Experience Studio Project: https://learning.monash.edu/course/view.php?id=41056
- **FIT5122** Professional Practice: https://learning.monash.edu/course/view.php?id=41057
- **FIT5231** Indigenous Data Sovereignty: https://learning.monash.edu/course/view.php?id=41065

## Workflow

1. Open the target URL with `browser(action=open, profile=chrome, targetUrl=...)`
2. Take a screenshot to confirm it loaded and the user is logged in
3. Use `browser(action=snapshot)` to extract structured content
4. Navigate into specific course/activity pages as needed
5. Report findings clearly — deadlines, task descriptions, what to do next

## Tips

- Always use `profile=chrome` (user is already logged in)
- If the tab gets detached mid-session, use `browser(action=tabs, profile=chrome)` to find the active tab, or re-open the URL
- Dashboard shows the **Timeline** (upcoming DDLs) and **Calendar** — great for quick overview
- Course pages show weekly sections with readings, quizzes, and assignments
- For detailed assignment instructions, click through to the assignment/quiz page

## Current Semester: S1 2026

See `references/courses.md` for course details, known DDLs, and assignment descriptions.
