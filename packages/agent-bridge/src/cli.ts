import { serveBridgeStdio } from "./server";
import { redactSensitiveText } from "./logging/redacting-logger";

try {
  serveBridgeStdio();
} catch (error) {
  process.stderr.write(`${error instanceof Error
    ? redactSensitiveText(error.message)
    : "ArtifactPass bridge failed"}\n`);
  process.exitCode = 1;
}
