/* Minimal console formatting — no dependency, degrades to plain text in a launchd log. */
const ESC = "[";
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (useColor ? `${ESC}${code}m${s}${ESC}0m` : s);

export const dim = wrap("2");
export const bold = wrap("1");
export const green = wrap("32");
export const yellow = wrap("33");
export const red = wrap("31");
export const cyan = wrap("36");

const stamp = () => dim(new Date().toISOString().slice(11, 19));

export function info(msg: string): void {
  console.log(`${stamp()} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`${stamp()} ${yellow("warn")} ${msg}`);
}

export function fail(msg: string): void {
  console.error(`${stamp()} ${red("error")} ${msg}`);
}
