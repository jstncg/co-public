import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

function readSecretFile(file: string, name: string, shared: boolean): string {
  const fd = openSync(resolve(file), "r");
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error(`Secret source for ${name} must be a regular file`);
    // A shared dotenv file contains credentials for more than this service. It
    // must not be writable by another account; never import it into process.env.
    if (shared && ((info.mode & 0o022) !== 0
      || (process.getuid && info.uid !== process.getuid() && info.uid !== 0))) {
      throw new Error(`Shared secret source for ${name} must be owner-controlled`);
    }
    const bytes = Buffer.alloc(65_537);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > 65_536) throw new Error(`Secret source for ${name} exceeds 64 KiB`);
    const value = bytes.subarray(0, size).toString("utf8");
    if (value.includes("\0")) throw new Error(`Secret source for ${name} contains a null byte`);
    return value;
  } finally { closeSync(fd); }
}

export function readSecret(name: string, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Invalid secret environment variable name");
  const inline = environment[name];
  const file = environment[`${name}_FILE`];
  const dotenv = environment[`${name}_DOTENV_FILE`];
  if ([inline, file, dotenv].filter((value) => value !== undefined).length > 1) {
    throw new Error(`Set only one of ${name}, ${name}_FILE or ${name}_DOTENV_FILE`);
  }
  if (inline) return inline;
  if (!file && !dotenv) return undefined;
  const source = readSecretFile(dotenv ?? file!, name, Boolean(dotenv));
  // Node's dotenv parser performs no shell evaluation or variable expansion.
  // Return exactly the selected credential, not unrelated connector authority.
  const value = dotenv ? parseEnv(source)[name] : source.trim();
  if (!value) throw new Error(`Secret source for ${name} has no nonempty value`);
  return value;
}
