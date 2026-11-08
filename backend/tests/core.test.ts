import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { decrypt, encrypt, hashPassword, maskSecret, parseKey, validatePasswordStrength, verifyPassword } from "../src/lib/crypto.js";
import { PathError, safeRelPath } from "../src/lib/paths.js";
import { buildZip, inspectAndExtractZip, ZipValidationError, DEFAULT_ZIP_LIMITS } from "../src/lib/zipInspect.js";
import { detectProject, DetectionError, validateRequirements } from "../src/lib/detect.js";
import { buildTar } from "../src/lib/tar.js";
import { TOKEN_RE, verifyBotToken } from "../src/lib/telegram.js";
import { buildEnvFile, buildNetworkPolicy, DeployError, processState, runDeployment, shq, startCommand, stopProcess, readLogChunk, type DeployHooks } from "../src/services/deployer.js";
import { FakeRuntime } from "./fakeRuntime.js";

const key = parseKey(randomBytes(32).toString("hex"));
const files = (o: Record<string, string>) => new Map(Object.entries(o).map(([k, v]) => [k, Buffer.from(v)]));

// ---------- crypto ----------
test("encrypt/decrypt round trip and tamper detection", () => {
  const blob = encrypt("123456:ABC-secret", key);
  assert.equal(decrypt(blob, key), "123456:ABC-secret");
  assert.notEqual(blob, encrypt("123456:ABC-secret", key), "random IV");
  const parts = blob.split("."); parts[3] = Buffer.from("tampered").toString("base64url");
  assert.throws(() => decrypt(parts.join("."), key));
  assert.throws(() => decrypt(blob, parseKey(randomBytes(32).toString("hex"))));
});
test("ENCRYPTION_KEY: short rejected, long secrets derive a stable 32-byte key", () => {
  assert.throws(() => parseKey("short"));
  const k = parseKey("x".repeat(40)); assert.equal(k.length, 32); assert.deepEqual(k, parseKey("x".repeat(40)));
  assert.equal(parseKey("ab".repeat(32)).length, 32);
});
test("password hashing and verification", async () => {
  const h = await hashPassword("correct horse 42");
  assert.ok(h.startsWith("scrypt$"));
  assert.equal(await verifyPassword("correct horse 42", h), true);
  assert.equal(await verifyPassword("wrong password 1", h), false);
  assert.equal(await verifyPassword("x", "garbage"), false);
});
test("password strength + secret masking", () => {
  assert.ok(validatePasswordStrength("short1"));
  assert.ok(validatePasswordStrength("alllettersnodigits"));
  assert.equal(validatePasswordStrength("goodpassword123"), null);
  assert.ok(!maskSecret("123456:ABCDEFGHIJKLMNOP").includes("ABCDEFGH"));
});

// ---------- paths (file manager security) ----------
test("safeRelPath blocks traversal and absolute paths", () => {
  for (const bad of ["../etc/passwd", "a/../../b", "/etc/passwd", "C:/x", "a\\b", "a/\u0000b", "a/..", ".."]) assert.throws(() => safeRelPath(bad), PathError, bad);
  assert.throws(() => safeRelPath(123 as any));
  assert.throws(() => safeRelPath("a".repeat(600)));
  assert.throws(() => safeRelPath(""));
});
test("safeRelPath normalises", () => {
  assert.equal(safeRelPath("./src//bot.py"), "src/bot.py");
  assert.equal(safeRelPath("", { allowRoot: true }), "");
});

// ---------- zip ----------
test("valid zip extracts, strips wrapper folder", () => {
  const z = buildZip([{ name: "proj/main.py", data: "print(1)", deflate: true }, { name: "proj/requirements.txt", data: "aiogram==3.4.1\n" }]);
  const r = inspectAndExtractZip(z);
  assert.deepEqual([...r.files.keys()].sort(), ["main.py", "requirements.txt"]);
  assert.equal(r.files.get("main.py")!.toString(), "print(1)");
});
test("zip: rejects path traversal / absolute / backslash entries", () => {
  for (const name of ["../evil.py", "a/../../evil.py", "/abs.py", "a\\b.py"]) {
    assert.throws(() => inspectAndExtractZip(buildZip([{ name, data: "x" }])), (e: any) => e instanceof ZipValidationError && e.code === "bad_path", name);
  }
});
test("zip: rejects symlinks and special files", () => {
  assert.throws(() => inspectAndExtractZip(buildZip([{ name: "link", data: "/etc/passwd", mode: 0o120777 }])), (e: any) => e.code === "symlink");
  assert.throws(() => inspectAndExtractZip(buildZip([{ name: "dev", data: "", mode: 0o020644 }])), (e: any) => e.code === "special_file");
});
test("zip: rejects non-zip, oversize, too many entries, duplicates, empty", () => {
  assert.throws(() => inspectAndExtractZip(Buffer.from("not a zip at all, definitely")), (e: any) => e.code === "not_zip");
  assert.throws(() => inspectAndExtractZip(buildZip([{ name: "a.py", data: "x" }]), { ...DEFAULT_ZIP_LIMITS, maxZipBytes: 10 }), (e: any) => e.code === "too_large");
  assert.throws(() => inspectAndExtractZip(buildZip([{ name: "a", data: "1" }, { name: "b", data: "2" }]), { ...DEFAULT_ZIP_LIMITS, maxEntries: 1 }), (e: any) => e.code === "too_many_entries");
  assert.throws(() => inspectAndExtractZip(buildZip([{ name: "A.py", data: "1" }, { name: "a.py", data: "2" }])), (e: any) => e.code === "duplicate");
  assert.throws(() => inspectAndExtractZip(buildZip([{ name: "node_modules/x.js", data: "1" }])), (e: any) => e.code === "empty");
});
test("zip: detects zip bombs (ratio and declared total)", () => {
  const big = Buffer.alloc(5 * 1024 * 1024, 0); // compresses ~5000:1
  assert.throws(() => inspectAndExtractZip(buildZip([{ name: "bomb.bin", data: big, deflate: true }])), (e: any) => e.code === "zip_bomb");
  assert.throws(() => inspectAndExtractZip(buildZip([{ name: "a.txt", data: "x".repeat(3000), deflate: true }]), { ...DEFAULT_ZIP_LIMITS, maxTotalBytes: 1000 }), (e: any) => e.code === "zip_bomb");
});
test("zip: lying size header cannot expand past declared size", () => {
  const z = buildZip([{ name: "a.txt", data: "x".repeat(5000), deflate: true }]);
  z.writeUInt32LE(10, 22); // local header usize irrelevant; patch central dir usize to 10
  const cd = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  z.writeUInt32LE(10, cd + 24);
  assert.throws(() => inspectAndExtractZip(z), (e: any) => e instanceof ZipValidationError);
});
test("zip: detects CRC corruption", () => {
  const z = buildZip([{ name: "a.txt", data: "hello world" }]);
  const cd = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); z.writeUInt32LE(0xdeadbeef, cd + 16);
  assert.throws(() => inspectAndExtractZip(z), (e: any) => e.code === "corrupt");
});

// ---------- detection ----------
test("detects python by contents, not name", () => {
  const m = detectProject(files({ "requirements.txt": "python-telegram-bot==21.0\n", "bot.py": "print()" }));
  assert.equal(m.language, "python"); assert.equal(m.entryPoint, "bot.py");
  assert.deepEqual(m.requiredTools, ["python3", "pip"]);
  assert.ok(m.installCommands.some((c) => c.includes("-r requirements.txt")));
  assert.equal(m.startCommand, ".venv/bin/python -u bot.py");
});
test("detects node: npm ci with lockfile, npm install without", () => {
  const pj = JSON.stringify({ main: "bot.js", dependencies: { telegraf: "^4" } });
  assert.deepEqual(detectProject(files({ "package.json": pj, "package-lock.json": "{}", "bot.js": "" })).installCommands, ["npm ci --no-audit --no-fund"]);
  const m = detectProject(files({ "package.json": pj, "bot.js": "" }));
  assert.deepEqual(m.installCommands, ["npm install --no-audit --no-fund"]);
  assert.equal(m.startCommand, "node bot.js");
});
test("node: uses start script and build script", () => {
  const m = detectProject(files({ "package.json": JSON.stringify({ scripts: { start: "node dist/i.js", build: "tsc", postinstall: "x" } }), "src/index.ts": "" }));
  assert.equal(m.startCommand, "npm start --silent"); assert.deepEqual(m.buildCommands, ["npm run build"]); assert.ok(m.warnings.length);
});
test("detects php with composer", () => {
  const m = detectProject(files({ "composer.json": "{}", "index.php": "<?php" }));
  assert.equal(m.language, "php"); assert.ok(m.installCommands[0].startsWith("composer install")); assert.equal(m.startCommand, "php index.php");
});
test("detection errors: unsupported, ambiguous, invalid json, no entry, bad override", () => {
  assert.throws(() => detectProject(files({ "readme.md": "x" })), (e: any) => e instanceof DetectionError && e.code === "unsupported");
  assert.throws(() => detectProject(files({ "requirements.txt": "x==1", "package.json": "{}" })), (e: any) => e.code === "ambiguous");
  assert.throws(() => detectProject(files({ "package.json": "{nope", "index.js": "" })), (e: any) => e.code === "invalid_manifest");
  assert.throws(() => detectProject(files({ "requirements.txt": "x==1", "other.py": "" })), (e: any) => e.code === "no_entry");
  assert.throws(() => detectProject(files({ "requirements.txt": "x==1", "main.py": "" }), { entryPoint: "../x; rm -rf /" }), (e: any) => e.code === "bad_entry");
});
test("requirements.txt validation blocks index overrides, URLs, paths", () => {
  assert.deepEqual(validateRequirements("aiogram==3.4.1\nrequests>=2.31,<3\n# c\nhttpx[http2]~=0.27 ; python_version>'3.9'\n"), []);
  for (const bad of ["--index-url https://evil/simple", "-r other.txt", "git+https://github.com/x/y", "evil @ https://x/y.whl", "./local", "bad name!"])
    assert.ok(validateRequirements(bad).length, bad);
  assert.throws(() => detectProject(files({ "requirements.txt": "--extra-index-url http://x\n", "main.py": "" })), (e: any) => e.code === "invalid_manifest");
});

// ---------- tar / shell safety ----------
test("tar output is block aligned with end marker", () => {
  const t = buildTar(files({ "a.py": "x", "dir/b.py": "y".repeat(600) }));
  assert.equal(t.length % 512, 0); assert.equal(t.subarray(0, 5).toString(), "a.py\0"); assert.ok(t.includes("ustar"));
});
test("shell quoting neutralises injection in env values", () => {
  const f = buildEnvFile("1:tok", { X: "a'; rm -rf / #" });
  assert.ok(f.includes(`export X='a'\\''; rm -rf / #'`));
  assert.throws(() => buildEnvFile("1:tok", { "BAD NAME": "x" }));
  assert.equal(shq("it's"), `'it'\\''s'`);
});
test("telegram token format + getMe verification (mocked fetch)", async () => {
  assert.ok(TOKEN_RE.test("123456789:AAEhBOweik6ad9r_QXMENQjcrTu1jAjBeCE"));
  assert.equal(TOKEN_RE.test("nope"), false);
  const ok = (async () => new Response(JSON.stringify({ ok: true, result: { id: 1, username: "demo_bot", first_name: "Demo" } }))) as any;
  assert.equal((await verifyBotToken("123456789:AAEhBOweik6ad9r_QXMENQjcrTu1jAjBeCE", ok)).username, "demo_bot");
  const bad = (async () => new Response(JSON.stringify({ ok: false }), { status: 401 })) as any;
  await assert.rejects(verifyBotToken("123456789:AAEhBOweik6ad9r_QXMENQjcrTu1jAjBeCE", bad));
  await assert.rejects(verifyBotToken("garbage"));
});

// ---------- deployment pipeline (fake runtime) ----------
function hooks() {
  const logs: string[] = [], stages: string[] = [], created: string[] = [];
  const h: DeployHooks = { log: (_s, t) => { logs.push(t); }, stage: (s) => { stages.push(s); }, sandboxCreated: (id) => { created.push(id); } };
  return { h, logs, stages, created };
}
const pyInput = () => ({
  botToken: "1:tok", env: { FOO: "bar" }, files: files({ "main.py": "print(1)", "requirements.txt": "aiogram==3.4.1" }),
  manifest: detectProject(files({ "main.py": "", "requirements.txt": "aiogram==3.4.1" })), plan: "1c-2g", egress: [], startupWaitMs: 5,
});

test("deploy success: stages in order, process verified, egress allow-list, no idle suspension config in input", async () => {
  const rt = new FakeRuntime(); const { h, stages, created } = hooks();
  const r = await runDeployment(rt, pyInput(), h);
  assert.equal(r.pid, 4242); assert.deepEqual(created, [r.sandboxId]);
  assert.deepEqual(stages, ["provisioning", "uploading", "checking", "installing", "starting"]);
  assert.equal(await processState(rt, r.sandboxId), "running");
  const sb = rt.sandboxes.get(r.sandboxId)!;
  assert.equal(sb.opts.networkPolicy.type, "allow-list");
  assert.ok(sb.opts.networkPolicy.rules!.some((x) => x.domain === "api.telegram.org"));
  assert.ok(sb.env!.toString().includes("BOT_TOKEN='1:tok'"));
  assert.ok(!JSON.stringify(sb.opts).includes("DATABASE_URL"), "no platform secrets passed to sandbox");
  assert.ok(sb.files.has("app"));
});
test("deploy fails honestly when process crashes at start; sandbox terminated; error output logged", async () => {
  const rt = new FakeRuntime(); rt.crashOnStart = true; const { h, logs } = hooks();
  await assert.rejects(runDeployment(rt, pyInput(), h), (e: any) => e instanceof DeployError && e.stage === "starting");
  assert.ok(logs.join("").includes("Traceback: boom"));
  assert.ok([...rt.sandboxes.values()].every((s) => s.terminated));
});
test("deploy fails with real build error and surfaces command output", async () => {
  const rt = new FakeRuntime(); rt.failCommandMatching = /pip install/; const { h, logs } = hooks();
  await assert.rejects(runDeployment(rt, pyInput(), h), (e: any) => e.stage === "installing" && /pip install/.test(e.message));
  assert.ok(logs.join("").includes("ERROR: failed"));
});
test("deploy fails clearly when a required tool is missing in the sandbox image", async () => {
  const rt = new FakeRuntime(); rt.missingTools.add("python3"); const { h } = hooks();
  await assert.rejects(runDeployment(rt, pyInput(), h), (e: any) => e.stage === "checking" && /python3/.test(e.message));
});
test("deploy reports disabled runtime instead of faking success", async () => {
  const rt = new FakeRuntime(); rt.runtimeOk = false; const { h } = hooks();
  await assert.rejects(runDeployment(rt, pyInput(), h), /not enabled/);
  assert.equal(rt.sandboxes.size, 0);
});
test("redeploy terminates previous sandbox first", async () => {
  const rt = new FakeRuntime(); const { h } = hooks();
  const a = await runDeployment(rt, pyInput(), h);
  const b = await runDeployment(rt, { ...pyInput(), previousSandboxId: a.sandboxId }, h);
  assert.equal(rt.sandboxes.get(a.sandboxId)!.terminated, true);
  assert.equal(await processState(rt, b.sandboxId), "running");
});
test("stop verifies real process state; stubborn process is force-killed", async () => {
  const rt = new FakeRuntime(); const { h } = hooks();
  const a = await runDeployment(rt, pyInput(), h);
  await stopProcess(rt, a.sandboxId, 50);
  assert.equal(await processState(rt, a.sandboxId), "stopped");
  const rt2 = new FakeRuntime(); rt2.stubborn = true;
  const b = await runDeployment(rt2, pyInput(), h);
  await stopProcess(rt2, b.sandboxId, 50);
  assert.ok(rt2.commands.some((c) => c.includes("kill -KILL")));
  assert.equal(await processState(rt2, b.sandboxId), "stopped");
});
test("start command redirects stdout/stderr to separate files and quotes the command", () => {
  const c = startCommand(pyInput().manifest);
  assert.ok(c.includes("run.out.log") && c.includes("run.err.log") && c.includes("exec .venv/bin/python -u main.py"));
});
test("network policy merges per-bot domains without duplicates", () => {
  const p = buildNetworkPolicy(["api.openai.com", "api.telegram.org"]);
  assert.equal(p.rules!.filter((r) => r.domain === "api.telegram.org").length, 1);
  assert.ok(p.rules!.some((r) => r.domain === "api.openai.com"));
});
test("readLogChunk advances offset by bytes", async () => {
  const rt = new FakeRuntime(); const id = (await rt.create({ plan: "x", networkPolicy: { type: "deny-all" } })).id;
  rt.exec = (async () => ({ exitCode: 0, stdout: "héllo\n", stderr: "" })) as any;
  const r = await readLogChunk(rt, id, "run.out.log", 10);
  assert.equal(r.newOffset, 10 + Buffer.byteLength("héllo\n"));
});
