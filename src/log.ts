// Single logging seam. V2 has no `client.app.log`; route everything through
// stderr so diagnostics survive without a plugin-visible logger.
import { SERVICE } from "./constants.js";

type Level = "debug" | "info" | "warn" | "error";

export function log(
  level: Level,
  message: string,
  extra?: Record<string, unknown>,
): void {
  const suffix =
    extra && Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : "";
  process.stderr.write(`${SERVICE}: [${level}] ${message}${suffix}\n`);
}
