export const ENABLE_MOUSE_TRACKING = "\u001B[?1000h\u001B[?1006h";
export const DISABLE_MOUSE_TRACKING =
  "\u001B[?1000l\u001B[?1002l\u001B[?1003l\u001B[?1015l\u001B[?1006l";

const SGR_MOUSE_PREFIXES = ["\u001B[<", "\u009B<", "[<"] as const;

interface SgrMouseInput {
  readonly button: number;
  readonly column: number;
  readonly row: number;
}

export interface MouseWheelInput {
  readonly direction: "up" | "down";
  readonly column: number;
  readonly row: number;
}

function parseSgrMouseInput(input: string): SgrMouseInput | undefined {
  const prefix = SGR_MOUSE_PREFIXES.find((candidate) => input.startsWith(candidate));
  const terminator = input.at(-1);
  if (prefix === undefined || (terminator !== "M" && terminator !== "m")) {
    return undefined;
  }
  const fields = input.slice(prefix.length, -1).split(";");
  if (fields.length !== 3 || fields.some((field) => !/^\d+$/.test(field))) {
    return undefined;
  }
  const [buttonText, columnText, rowText] = fields;
  const button = Number(buttonText);
  const column = Number(columnText);
  const row = Number(rowText);
  if (!Number.isInteger(button) || !Number.isInteger(column) || !Number.isInteger(row)) {
    return undefined;
  }
  return { button, column, row };
}

export function isMouseProtocolInput(input: string): boolean {
  return parseSgrMouseInput(input) !== undefined;
}

export function parseMouseWheelInput(input: string): MouseWheelInput | undefined {
  const mouse = parseSgrMouseInput(input);
  const wheelDirection = mouse === undefined ? undefined : mouse.button & 3;
  if (
    mouse === undefined ||
    (mouse.button & 64) === 0 ||
    wheelDirection === undefined ||
    wheelDirection > 1
  ) {
    return undefined;
  }
  return {
    direction: wheelDirection === 0 ? "up" : "down",
    column: mouse.column,
    row: mouse.row,
  };
}
