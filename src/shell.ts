import { execFile } from "node:child_process";

export async function execShell(params: {
  shell: string;
  command: string;
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { shell, command, env, cwd, timeoutMs } = params;
  return await new Promise((resolve, reject) => {
    execFile(shell, ["-lc", command], {
      env: { ...process.env, ...(env ?? {}) },
      cwd,
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout, stderr, exitCode: 0 });
        return;
      }
      const anyError = error as NodeJS.ErrnoException & { code?: string | number };
      if (typeof anyError.code === "number") {
        resolve({ stdout: stdout ?? "", stderr: stderr ?? anyError.message, exitCode: anyError.code });
        return;
      }
      reject(error);
    });
  });
}

export function renderTemplate(command: string, values: Record<string, string>): string {
  let output = command;
  for (const [key, value] of Object.entries(values)) {
    output = output.replaceAll(`{{${key}}}`, shellEscape(value));
  }
  return output;
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
