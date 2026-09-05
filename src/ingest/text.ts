/**
 * 容错文本提取：从 DSH content-block 消息中取出可见文本。
 * 不 import DSH Core 类型，防御性遍历 content 块；未知块类型跳过，
 * 嵌套 tool-result 内容递归访问。宁可取不到也不抛错。
 */

interface ContentBlock {
  type?: string;
  text?: string;
  content?: unknown;
}

interface MessageLike {
  content?: unknown;
}

/** 遍历 content 块，返回可见文本（换行连接）。 */
export function extractMessageText(message: unknown): string {
  if (message === null || typeof message !== "object") return "";
  const content = (message as MessageLike).content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const b = block as ContentBlock;
    switch (b.type) {
      case "text":
        if (typeof b.text === "string" && b.text.length > 0) parts.push(b.text);
        break;
      case "tool-result":
        // 嵌套 tool-result 内容递归访问。
        if (Array.isArray(b.content)) {
          const nested = extractMessageText({ content: b.content });
          if (nested.length > 0) parts.push(nested);
        }
        break;
      default:
        // reasoning / tool-call / image 等非用户可见文本，不入记忆。
        break;
    }
  }
  return parts.join("\n");
}

/** 归一化一行文本：空白折叠、截断，保持转录列紧凑。 */
export function collapseLine(text: string, max = 2000): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max)}…`;
}
