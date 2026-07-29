/**
 * Zero-dependency ANSI color helpers — this package's whole pitch is 0
 * runtime deps, so no chalk/picocolors here. Colors are suppressed when
 * stdout isn't a TTY (piped, redirected, captured by a test) or when
 * NO_COLOR is set (https://no-color.org — presence disables regardless of
 * value), and forced on with FORCE_COLOR for the inverse case (CI logs that
 * render ANSI, output piped through something that wants color anyway).
 */
const forceColor = "FORCE_COLOR" in process.env && process.env.FORCE_COLOR !== "0";
const noColor = "NO_COLOR" in process.env;
const colorEnabled = forceColor || (process.stdout.isTTY === true && !noColor);

function wrap(code: string): (text: string) => string {
  return (text: string) => (colorEnabled ? `\x1b[${code}m${text}\x1b[0m` : text);
}

export const dim = wrap("2");
export const bold = wrap("1");
export const red = wrap("31");
export const green = wrap("32");
export const yellow = wrap("33");
export const magenta = wrap("35");

/** The recurring `claude-code-merge-queue <command>:` log-line prefix, dimmed. */
export function tag(command: string): string {
  return dim(`claude-code-merge-queue ${command}:`);
}
