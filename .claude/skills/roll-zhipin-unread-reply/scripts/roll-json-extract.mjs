/**
 * Extract the last valid JSON object/array from roll CLI stdout (may include log lines).
 */
export function extractLastJson(text) {
  let lastValid = null;
  let lastEnd = -1;

  for (let start = 0; start < text.length; start++) {
    const first = text[start];
    if (first !== "{" && first !== "[") {
      continue;
    }
    const stack = [first];
    let inString = false;
    let escape = false;

    for (let end = start + 1; end < text.length; end++) {
      const c = text[end];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (c === "\\") {
          escape = true;
        } else if (c === '"') {
          inString = false;
        }
        continue;
      }
      if (c === '"') {
        inString = true;
        continue;
      }
      if (c === "{" || c === "[") {
        stack.push(c);
        continue;
      }
      if (c === "}" || c === "]") {
        const top = stack[stack.length - 1];
        const matches =
          (c === "}" && top === "{") || (c === "]" && top === "[");
        if (!matches) {
          break;
        }
        stack.pop();
        if (stack.length === 0) {
          const candidate = text.slice(start, end + 1);
          try {
            JSON.parse(candidate);
            if (end > lastEnd) {
              lastEnd = end;
              lastValid = candidate;
            }
          } catch {
            // invalid span
          }
          break;
        }
      }
    }
  }

  return lastValid;
}

export async function readStdinUtf8() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  return text;
}
