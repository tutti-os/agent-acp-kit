export function createJsonlParser<TEvent>(
  onMessage: (message: TEvent, raw: string) => void,
) {
  let buffer = "";

  const feedLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parsed = JSON.parse(trimmed) as TEvent;
    onMessage(parsed, trimmed);
  };

  return {
    feed(chunk: string) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        feedLine(line);
      }
    },
    flush() {
      if (!buffer.trim()) return;
      feedLine(buffer);
      buffer = "";
    },
  };
}
