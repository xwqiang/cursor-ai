const ESC = "\x1b";
const R = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;

const C = {
  gray: `${ESC}[90m`,
  cyan: `${ESC}[36m`,
  blue: `${ESC}[34m`,
  magenta: `${ESC}[35m`,
  yellow: `${ESC}[33m`,
  green: `${ESC}[32m`,
  red: `${ESC}[31m`,
  white: `${ESC}[37m`,
};

function ts(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

function line(color: string, tag: string, msg: string): void {
  process.stdout.write(
    `${C.gray}${ts()}${R} ${color}${BOLD}[${tag}]${R} ${msg}\n`,
  );
}

export const log = {
  startup: (msg: string) => line(C.cyan, "startup", msg),
  session: (msg: string) => line(C.magenta, "session", msg),
  recv: (msg: string) => line(C.blue, "recv", msg),
  warn: (msg: string) => line(C.yellow, "warn", msg),
  error: (msg: string) => line(C.red, "error", msg),
  probe: (ok: boolean, name: string, detail: string) =>
    line(
      ok ? C.green : C.red,
      "mcp-probe",
      `${ok ? "✓" : "✗"} ${name}  ${DIM}${detail}${R}`,
    ),
  probeStart: (count: number) =>
    line(C.cyan, "mcp-probe", `checking ${count} server(s)...`),
  tool: (label: string, name: string) =>
    line(C.yellow, label, `${BOLD}▶ tool_call${R}  ${name}`),
  toolResult: (label: string, result: string) =>
    line(C.yellow, label, `${DIM}↳ ${result}${R}`),
  thinkingStart: (label: string) =>
    process.stdout.write(
      `\n${C.gray}${ts()}${R} ${C.cyan}${DIM}[${label}]${R} ${DIM}┌── 💭 thinking ──────────────────────────────${R}\n`,
    ),
  thinkingChunk: (chunk: string) =>
    process.stdout.write(`${DIM}${chunk}${R}`),
  thinkingEnd: (label: string) =>
    process.stdout.write(
      `\n${C.gray}${ts()}${R} ${C.cyan}${DIM}[${label}]${R} ${DIM}└─────────────────────────────────────────────${R}\n\n`,
    ),
  textChunk: (chunk: string) => process.stdout.write(chunk),
  textBlock: (label: string, text: string) =>
    process.stdout.write(
      `${C.gray}${ts()}${R} ${C.white}[${label}]${R} ${text}\n`,
    ),
  turnEnd: (label: string) =>
    line(C.gray, label, `${DIM}— turn ended —${R}`),
};
