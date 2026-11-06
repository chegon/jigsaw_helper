import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { zipSync } from "fflate";
import { checkPrivacy } from "./check-private-data.mjs";

const account = "syntheticvault123";
const key = Buffer.alloc(64, 7).toString("base64");
const site = `https://${account}.z99.web.core.windows.net/jigsaw-helper/`;
const connection = `DefaultEndpointsProtocol=https;AccountName=${account};AccountKey=${key};EndpointSuffix=core.windows.net`;

function fixture(t, website = site) {
  const root = mkdtempSync(join(tmpdir(), "jigsaw-privacy-"));
  t.after(() => rmSync(root, { recursive: true }));
  const credentials = join(root, "access-key.yaml");
  writeFileSync(credentials, `Storage account name: ${account}\nConnection string: "${connection}"\nWebsite URL: "${website}"\n`);
  writeFileSync(join(root, "README.md"), "# Safe project\n");
  return { root, credentials };
}

function assertBlocked(action) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof Error);
    for (const value of [account, key, site, connection]) {
      assert.equal(error.message.toLowerCase().includes(value.toLowerCase()), false);
    }
    return /private|credential|endpoint/i.test(error.message);
  });
}

function gitRunner(root) {
  const windowsGit = join(process.env.ProgramFiles ?? "", "Git", "cmd", "git.exe");
  const git = process.platform === "win32" && existsSync(windowsGit) ? windowsGit : "git";
  return (...args) => {
    const result = spawnSync(git, args, { cwd: root, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, "Synthetic Git fixture command failed.");
  };
}

test("private configuration is excluded while safe public examples remain usable", (t) => {
  const { root } = fixture(t);
  writeFileSync(join(root, "access-key.example.yaml"), 'Storage account name: YOUR_STORAGE_ACCOUNT\nConnection string: "YOUR_FULL_HTTPS_CONNECTION_STRING"\nWebsite URL: "https://ACCOUNT.zXX.web.core.windows.net/jigsaw-helper/"\n');
  const result = checkPrivacy({ root });
  assert.equal(result.privateConfigPresent, true);
  assert.equal(result.filesScanned, 2);
});

test("actual account identifiers are blocked even inside a synthetic-test directory", (t) => {
  const { root } = fixture(t);
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "tests", "fixture.js"), `const account = "${account}";`);
  assertBlocked(() => checkPrivacy({ root }));
});

test("connection strings, real URLs, hosts, and encoded values are checked without printing them", (t) => {
  const { root } = fixture(t);
  const cases = [connection, site, new URL(site).host, encodeURIComponent(key), Buffer.from(account).toString("base64")];
  for (const value of cases) {
    writeFileSync(join(root, "README.md"), `Private example: ${value}`);
    assertBlocked(() => checkPrivacy({ root }));
  }
});

test("private custom-domain roots are protected independently of the account name", (t) => {
  const { root } = fixture(t, "https://synthetic.private.example/jigsaw-helper/");
  writeFileSync(join(root, "README.md"), "Visit https://synthetic.private.example/");
  assertBlocked(() => checkPrivacy({ root }));
});

test("private configuration backups and identifying file names are not safe publishable files", (t) => {
  const { root } = fixture(t);
  writeFileSync(join(root, `${account}.txt`), account);
  assertBlocked(() => checkPrivacy({ root }));
});

test("compressed distribution members are inspected as well as plain files", (t) => {
  const { root } = fixture(t);
  writeFileSync(join(root, "distribution.zip"), zipSync({ "index.html": Buffer.from(site) }, { level: 6 }));
  assertBlocked(() => checkPrivacy({ root }));
});

test("missing local configuration is reported and unknown literal Azure endpoints are still blocked", (t) => {
  const { root, credentials } = fixture(t);
  rmSync(credentials);
  assert.equal(checkPrivacy({ root }).privateConfigPresent, false);
  writeFileSync(join(root, "README.md"), "https://anotherexample.z8.web.core.windows.net/app/");
  assertBlocked(() => checkPrivacy({ root }));
});

test("a local configuration missing its final URL fails instead of silently weakening comparison", (t) => {
  const { root, credentials } = fixture(t);
  writeFileSync(credentials, `Storage account name: ${account}\nConnection string: "${connection}"\n`);
  assertBlocked(() => checkPrivacy({ root }));
});

test("old Git objects cannot retain identifiers after the current document is cleaned", (t) => {
  const { root } = fixture(t);
  const run = gitRunner(root);
  run("init", "--initial-branch=main");
  run("config", "user.name", "Synthetic Tester");
  run("config", "user.email", "synthetic@example.test");
  writeFileSync(join(root, "README.md"), site);
  run("add", "README.md");
  run("commit", "-m", "Add synthetic deployment example");
  writeFileSync(join(root, "README.md"), "# Sanitized current document\n");
  run("add", "README.md");
  run("commit", "-m", "Remove current example");
  assertBlocked(() => checkPrivacy({ root }));
});

test("Git administrative files are checked even when an identifier was never committed", (t) => {
  const { root } = fixture(t);
  gitRunner(root)("init", "--initial-branch=main");
  writeFileSync(join(root, ".git", "COMMIT_EDITMSG"), `Uncommitted private identifier: ${account}`);
  assertBlocked(() => checkPrivacy({ root }));
});

test("staged synthetic fixtures stay recognizable without exempting actual private values", (t) => {
  const { root } = fixture(t);
  const run = gitRunner(root);
  run("init", "--initial-branch=main");
  mkdirSync(join(root, "tests"));
  const path = join(root, "tests", "fixture.js");
  writeFileSync(path, 'const sample = "https://otherfixture.z1.web.core.windows.net/";');
  run("add", "tests/fixture.js");
  assert.equal(checkPrivacy({ root }).privateConfigPresent, true);
  writeFileSync(path, `const accidentalRealValue = "${account}";`);
  assertBlocked(() => checkPrivacy({ root }));
});
