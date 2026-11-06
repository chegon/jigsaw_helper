import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { unzipSync } from "fflate";

const defaultRoot = dirname(fileURLToPath(import.meta.url));
const excludedDirectories = new Set([".git", ".venv", "venv", "node_modules", "__pycache__", ".npm"]);
const maxFileSize = 64 * 1024 * 1024;

function readPrivateValues(path) {
  if (!existsSync(path)) return null;
  const fields = new Map();
  for (const [index, raw] of readFileSync(path, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    if (/^\s*(#.*)?$/.test(raw)) continue;
    const match = raw.match(/^\s*([^:]+):\s*(.*)$/);
    if (!match) throw new Error(`Private configuration syntax is invalid on line ${index + 1}; values withheld.`);
    const label = match[1].trim().replace(/^["']|["']$/g, "").replace(/[ _-]/g, "").toLowerCase();
    const key = label === "storageaccountname" ? "accountname" : label;
    let value = match[2].trim();
    if (/^["']/.test(value)) {
      const quote = value[0];
      const end = value.lastIndexOf(quote);
      if (end === 0 || !/^\s*(#.*)?$/.test(value.slice(end + 1))) {
        throw new Error(`Private configuration quoting is invalid on line ${index + 1}; values withheld.`);
      }
      value = value.slice(1, end).replace(/''/g, "'");
    } else value = value.replace(/\s+#.*$/, "").trim();
    if (fields.has(key)) throw new Error("Private configuration has duplicate fields; values withheld.");
    fields.set(key, value);
  }
  for (const field of ["accountname", "connectionstring", "websiteurl"]) {
    if (!fields.get(field)) throw new Error("Private configuration requires account, connection string, and Website URL; values withheld.");
  }
  const values = [fields.get("accountname"), fields.get("connectionstring"), fields.get("websiteurl")];
  for (const part of fields.get("connectionstring").split(";")) {
    const split = part.indexOf("=");
    if (split < 0) continue;
    const name = part.slice(0, split).trim().toLowerCase();
    if (["accountname", "accountkey", "sharedaccesssignature"].includes(name) || name.endsWith("endpoint")) {
      values.push(part.slice(split + 1).trim());
    }
  }
  let url;
  try { url = new URL(fields.get("websiteurl")); }
  catch { throw new Error("Private Website URL is invalid; value withheld."); }
  values.push(url.origin, url.host, url.hostname);
  return [...new Set(values.filter(Boolean).flatMap((value) => [
    value, encodeURIComponent(value), Buffer.from(value).toString("base64"),
  ]))];
}

function findGit() {
  const candidates = ["git"];
  if (process.platform === "win32") {
    for (const directory of [process.env.ProgramFiles, process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs")]) {
      if (directory) candidates.push(join(directory, "Git", "cmd", "git.exe"));
    }
  }
  for (const git of candidates) {
    const result = spawnSync(git, ["--version"], { encoding: "utf8", windowsHide: true });
    if (!result.error && result.status === 0) return git;
  }
  throw new Error("Git is required to inspect local history; private-data verification did not complete.");
}

export function checkPrivacy({
  root = defaultRoot,
  credentials = join(root, "access-key.yaml"),
  source = null,
} = {}) {
  root = resolve(root);
  credentials = resolve(credentials);
  const values = readPrivateValues(credentials);
  const tokens = (values ?? []).map((value) => value.toLowerCase());
  const report = { filesScanned: 0, gitObjectsScanned: 0, privateConfigPresent: values !== null };
  const safeLabel = (label) => {
    let result = label;
    for (const value of [...(values ?? [])].sort((a, b) => b.length - a.length)) {
      result = result.replaceAll(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[PRIVATE]");
    }
    return result;
  };
  const inspect = (data, label, testFixture = false) => {
    const text = data.toString("utf8");
    const lower = text.toLowerCase();
    if (tokens.some((token) => lower.includes(token))) {
      throw new Error(`Private infrastructure information found in ${safeLabel(label)}; matching values withheld.`);
    }
    if (/\bAccountKey\s*=\s*[A-Za-z0-9+/]{80,}={0,2}/.test(text) ||
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) {
      throw new Error(`Possible private credential found in ${safeLabel(label)}; matching values withheld.`);
    }
    if (!testFixture && /https?:\/\/[a-z0-9]+(?:\.z\d+)?\.(?:web|blob|dfs|file|queue|table)\.core\.(?:windows\.net|usgovcloudapi\.net|chinacloudapi\.cn)\b/i.test(text)) {
      throw new Error(`Account-specific Azure endpoint found in ${safeLabel(label)}; use a placeholder.`);
    }
  };
  const isFixture = (path) => path.startsWith("tests/") || /(?:^|\/)[^/]+\.test\.mjs$/.test(path);
  const scanned = new Set();
  const walk = (directory, gitMetadata = false) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (path === credentials || scanned.has(path)) continue;
      if (entry.isSymbolicLink()) throw new Error("Private-data scan refuses symbolic links; inspect their targets explicitly.");
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name) && !(gitMetadata && entry.name === "objects")) walk(path, gitMetadata);
        continue;
      }
      if (!entry.isFile()) continue;
      scanned.add(path);
      const label = relative(root, path).split(sep).join("/");
      if (lstatSync(path).size > maxFileSize) throw new Error(`File too large for private-data inspection: ${safeLabel(label)}.`);
      const data = readFileSync(path);
      inspect(data, gitMetadata ? "Git administrative metadata" : label, !gitMetadata && isFixture(label));
      report.filesScanned++;
      if (entry.name.endsWith(".zip")) {
        let total = 0;
        const files = unzipSync(data, {
          filter: (file) => {
            total += file.originalSize;
            if (file.originalSize > maxFileSize || total > maxFileSize * 2) {
              throw new Error("Archive exceeds the private-data scan memory limit.");
            }
            return true;
          },
        });
        for (const bytes of Object.values(files)) inspect(Buffer.from(bytes), `${safeLabel(label)} (archive member)`);
      }
    }
  };
  walk(root);
  if (source && resolve(source) !== root) walk(resolve(source));

  if (existsSync(join(root, ".git"))) {
    const git = findGit();
    const run = (...args) => {
      const result = spawnSync(git, args, { cwd: root, maxBuffer: maxFileSize, windowsHide: true });
      if (result.error || result.status !== 0) throw new Error("Git private-data inspection failed; raw diagnostics withheld.");
      return result.stdout;
    };
    const paths = new Map();
    for (const line of run("rev-list", "--objects", "--all").toString().trim().split(/\r?\n/)) {
      const space = line.indexOf(" ");
      if (space >= 0) paths.set(line.slice(0, space), line.slice(space + 1));
    }
    for (const record of run("ls-files", "--stage", "-z").toString().split("\0")) {
      if (!record) continue;
      const tab = record.indexOf("\t");
      const [, id] = record.slice(0, tab).split(" ");
      paths.set(id, record.slice(tab + 1));
    }
    for (const row of run("cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)").toString().trim().split(/\r?\n/)) {
      if (!row) continue;
      const [id, type] = row.split(" ");
      const path = paths.get(id) ?? "";
      if (/(^|\/)access-key(?!\.example\.yaml$).*\.ya?ml(?:$|\.)/i.test(path)) {
        throw new Error("A real credential configuration filename exists in Git history.");
      }
      inspect(run("cat-file", type, id), path ? `Git history: ${safeLabel(path)}` : "Git history/object", isFixture(path));
      report.gitObjectsScanned++;
    }
    if (lstatSync(join(root, ".git")).isDirectory()) walk(join(root, ".git"), true);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = {};
    for (let index = 2; index < process.argv.length; index += 2) {
      const flag = process.argv[index], value = process.argv[index + 1];
      if (!value || !["--credentials", "--source"].includes(flag)) throw new Error("Use --credentials PATH or --source PATH; do not pass private values.");
      options[flag === "--credentials" ? "credentials" : "source"] = isAbsolute(value) ? value : resolve(value);
    }
    const report = checkPrivacy(options);
    console.log(`Private-data check passed: ${report.filesScanned} files and ${report.gitObjectsScanned} Git objects.`);
    if (!report.privateConfigPresent) console.log("No local private configuration: only generic exposure patterns could be checked.");
  } catch (error) {
    const message = error && typeof error === "object" && "code" in error
      ? "Private-data file inspection failed; raw filesystem diagnostics withheld."
      : error instanceof Error ? error.message : "Private-data check failed; details withheld.";
    console.error(message);
    process.exitCode = 1;
  }
}
