import { hashPassword } from "./auth.js";

function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return Promise.reject(new Error("Run this command in an interactive terminal."));
  }

  return new Promise((resolve, reject) => {
    let value = "";
    process.stderr.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();

    const finish = (error?: Error) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };

    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish(new Error("Password setup cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = Array.from(value).slice(0, -1).join("");
          continue;
        }
        if (!/[\u0000-\u001f\u007f]/u.test(character)) value += character;
      }
    };

    process.stdin.on("data", onData);
  });
}

try {
  const password = await readHidden("New Kudu operator password (12+ characters): ");
  const confirmation = await readHidden("Confirm password: ");
  if (password !== confirmation) throw new Error("Passwords do not match.");
  const passwordHash = await hashPassword(password);
  process.stdout.write(`KUDU_AUTH_PASSWORD_HASH=${passwordHash}\n`);
  process.stdout.write("Store this hash as a secret; do not commit it to the repository.\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Password setup failed."}\n`);
  process.exitCode = 1;
}
