/* Minimal CLI output. No spinner library - stages are long and log-driven. */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, s: string) =>
  useColor ? `\x1b[${code}m${s}\x1b[0m` : s;

export const dim = (s: string) => paint("2", s);
export const bold = (s: string) => paint("1", s);
export const green = (s: string) => paint("32", s);
export const yellow = (s: string) => paint("33", s);
export const red = (s: string) => paint("31", s);
export const cyan = (s: string) => paint("36", s);

export const log = {
  step: (msg: string) => console.log(`${cyan("›")} ${msg}`),
  info: (msg: string) => console.log(`  ${msg}`),
  detail: (msg: string) => console.log(dim(`  ${msg}`)),
  ok: (msg: string) => console.log(`${green("✓")} ${msg}`),
  warn: (msg: string) => console.warn(`${yellow("!")} ${msg}`),
  error: (msg: string) => console.error(`${red("✗")} ${msg}`),
  blank: () => console.log(""),
};

export function fmtDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function fmtCount(n: number, singular: string, plural = `${singular}s`) {
  return `${n} ${n === 1 ? singular : plural}`;
}
