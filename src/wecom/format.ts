/**
 * 微信消息格式转换
 *
 * 将 Markdown 格式转换为微信友好的纯文本格式
 * 微信客服消息不支持 Markdown 渲染，需要转换后发送
 */

/**
 * 规范化空白字符
 */
function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * 将 Markdown 表格转换为易读的列表格式
 */
function convertTableToList(tableText: string): string {
  const lines = tableText.trim().split("\n");
  if (lines.length < 2) return tableText;

  // 解析表头
  const headerLine = lines[0];
  const headers = headerLine
    .split("|")
    .map((h) => h.trim())
    .filter((h) => h);

  // 跳过分隔行（第二行通常是 |---|---|）
  const dataLines = lines.slice(2);

  const result: string[] = [];

  for (const line of dataLines) {
    const cells = line
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c);
    if (cells.length === 0) continue;

    // 将每行数据格式化为 "字段: 值" 的形式
    const rowParts: string[] = [];
    for (let i = 0; i < cells.length && i < headers.length; i++) {
      if (cells[i]) {
        rowParts.push(`${headers[i]}: ${cells[i]}`);
      }
    }
    if (rowParts.length > 0) {
      result.push(`- ${rowParts.join(" | ")}`);
    }
  }

  return result.join("\n");
}

/**
 * 将 Markdown 转换为微信友好的纯文本格式
 *
 * 转换规则：
 * - 标题：移除 # 符号，保留文本
 * - 粗体/斜体：移除 **、*、_ 符号，保留文本
 * - 删除线：移除 ~~ 符号，保留文本
 * - 链接：[文本](url) → 文本 (url)
 * - 图片：![alt](url) → [图片: alt]
 * - 代码块：移除 ``` 标记，保留代码内容
 * - 行内代码：移除 ` 标记，保留内容
 * - 表格：转换为列表格式
 * - 引用：> 转换为 「」
 * - 列表：保留，简化符号
 */
export function convertMarkdownForWeChat(markdown: string): string {
  if (!markdown) return markdown;

  let text = markdown;

  // 处理代码块 - 保留内容，移除标记
  text = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_match, code) => {
    const trimmedCode = code.trim();
    if (!trimmedCode) return "";
    // 给代码块添加缩进标识（使用纯文本标记，避免特殊字符）
    return `[代码]\n${trimmedCode}\n[/代码]`;
  });

  // 处理表格
  text = text.replace(
    /\|[^\n]+\|\n\|[-:\s|]+\|\n(\|[^\n]+\|\n?)+/g,
    (table) => `\n${convertTableToList(table)}\n`,
  );

  // 处理图片 ![alt](url) → [图片]
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, (_match, alt) => {
    return alt ? `[图片: ${alt}]` : "[图片]";
  });

  // 处理链接 [文本](url) → 文本
  // 保留 URL 以便用户可以复制
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, linkText, url) => {
    // 如果链接文本和 URL 相同，只显示一次
    if (linkText.trim() === url.trim()) {
      return url;
    }
    return `${linkText} (${url})`;
  });

  // 处理标题 - 转换为加粗效果（用方括号强调）
  text = text.replace(/^#{1,6}\s+(.+)$/gm, (_match, heading) => {
    return `[${heading.trim()}]`;
  });

  // 处理粗体 **text** 或 __text__
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");

  // 处理斜体 *text* 或 _text_（注意不要匹配已处理的粗体）
  text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1");
  text = text.replace(/(?<!_)_([^_]+)_(?!_)/g, "$1");

  // 处理删除线
  text = text.replace(/~~([^~]+)~~/g, "$1");

  // 处理行内代码 - 使用普通引号
  text = text.replace(/`([^`]+)`/g, '"$1"');

  // 处理引用 - 使用普通引号
  text = text.replace(/^>\s*(.+)$/gm, "> $1");

  // 处理无序列表 - 使用普通横杠
  text = text.replace(/^\s*[-*+]\s+/gm, "- ");

  // 处理有序列表 - 保持数字
  text = text.replace(/^\s*(\d+)\.\s+/gm, "$1. ");

  // 处理水平分割线 - 使用普通横杠
  text = text.replace(/^[-*_]{3,}\s*$/gm, "--------");

  // 规范化空白
  text = normalizeWhitespace(text);

  return text;
}
