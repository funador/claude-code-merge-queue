/**
 * A synchronous, type-the-exact-word confirmation prompt read straight from
 * /dev/tty — the same trick interactive git hooks use, since stdin during a
 * `git push` is git's own protocol, not free for a hook to read from.
 *
 * Used exactly once: the emergency bypass for a blocked push (see
 * check-push.ts). Returns null if there's no interactive terminal to prompt
 * on at all (CI, a piped/non-interactive push) — the caller treats that as
 * "can't confirm," not "confirmed."
 */
import { openSync, closeSync, readSync, writeSync } from "node:fs";

export function promptTtyConfirm(promptText: string): string | null {
  let fd: number;
  try {
    fd = openSync("/dev/tty", "r+");
  } catch {
    return null;
  }
  try {
    writeSync(fd, promptText);
    const buf = Buffer.alloc(1);
    let input = "";
    for (;;) {
      let bytesRead: number;
      try {
        bytesRead = readSync(fd, buf, 0, 1, null);
      } catch {
        break;
      }
      if (bytesRead <= 0) break;
      const ch = buf.toString("utf8");
      if (ch === "\n" || ch === "\r") break;
      input += ch;
    }
    return input.trim();
  } finally {
    closeSync(fd);
  }
}
