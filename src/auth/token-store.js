import { promises as fs } from "fs";
import path from "path";
import { env } from "../config/env.js";
import { AppError } from "../utils/errors.js";

const accountsDir = env.ACCOUNTS_DIR;

async function ensureAccountsDir() {
  await fs.mkdir(accountsDir, { recursive: true });
}

function tokenFile(alias) {
  return path.join(accountsDir, `${alias}.json`);
}

export async function listAccountAliases() {
  await ensureAccountsDir();
  const files = await fs.readdir(accountsDir);
  return files
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.replace(/\.json$/, ""));
}

export async function readTokens(alias) {
  await ensureAccountsDir();
  const filePath = tokenFile(alias);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new AppError(`No tokens found for alias "${alias}"`, "ACCOUNT_NOT_FOUND", 404);
    }
    throw error;
  }
}

export async function writeTokens(alias, tokens) {
  await ensureAccountsDir();
  const filePath = tokenFile(alias);
  await fs.writeFile(filePath, `${JSON.stringify(tokens, null, 2)}\n`, "utf8");
  await fs.chmod(filePath, 0o600);
}
