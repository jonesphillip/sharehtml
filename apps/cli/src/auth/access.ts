import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let cloudflaredAvailable: boolean | null = null;

async function hasCloudflaredBinary(): Promise<boolean> {
  if (cloudflaredAvailable !== null) return cloudflaredAvailable;

  try {
    await execFileAsync("cloudflared", ["--version"], { encoding: "utf-8" });
    cloudflaredAvailable = true;
  } catch {
    cloudflaredAvailable = false;
  }

  return cloudflaredAvailable;
}

export async function ensureCloudflaredInstalled(): Promise<void> {
  if (await hasCloudflaredBinary()) return;
  throw new Error(
    "cloudflared is required for Cloudflare Access login. Install it, then run: sharehtml login",
  );
}

export async function loginWithAccess(workerUrl: string): Promise<void> {
  await ensureCloudflaredInstalled();
  await new Promise<void>((resolve, reject) => {
    const child = execFile("cloudflared", ["access", "login", workerUrl], (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
  });
}

export async function getAccessToken(workerUrl: string): Promise<string | null> {
  if (!(await hasCloudflaredBinary())) return null;

  try {
    const { stdout } = await execFileAsync(
      "cloudflared",
      ["access", "token", `-app=${workerUrl}`],
      { encoding: "utf-8" },
    );
    const token = stdout.trim();
    return token || null;
  } catch {
    return null;
  }
}

export async function getAuthHeaders(
  workerUrl: string,
): Promise<{ headers: Record<string, string>; canLogin: boolean }> {
  const token = await getAccessToken(workerUrl);
  if (!token) {
    return {
      headers: {},
      canLogin: await hasCloudflaredBinary(),
    };
  }

  return {
    headers: { "cf-access-token": token },
    canLogin: true,
  };
}
