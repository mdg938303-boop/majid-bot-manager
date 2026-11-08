/** Content-based language, entry-point and dependency-manifest detection. */
export type Language = "python" | "node" | "php";

export interface Manifest {
  language: Language;
  entryPoint: string;
  dependencyFiles: string[];
  installCommands: string[];
  buildCommands: string[];
  startCommand: string;
  requiredTools: string[];
  warnings: string[];
}

export class DetectionError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

const ENTRY_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;
const PY_ENTRIES = ["main.py", "bot.py", "app.py", "src/main.py", "src/bot.py", "__main__.py"];
const NODE_ENTRIES = ["index.js", "bot.js", "src/index.js", "main.js", "app.js", "index.mjs", "src/index.ts"];
const PHP_ENTRIES = ["index.php", "bot.php", "main.php", "src/index.php"];

const text = (files: Map<string, Buffer>, p: string) => files.get(p)?.toString("utf8");

export function validateRequirements(src: string): string[] {
  const errors: string[] = [];
  const pkg = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._-]+\])?\s*((===|==|>=|<=|~=|!=|>|<)\s*[A-Za-z0-9.*+!_-]+\s*,?\s*)*(;[^#]*)?$/;
  src.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) return;
    if (line.startsWith("-")) errors.push(`requirements.txt line ${i + 1}: option lines (${line.split(/\s/)[0]}) are not allowed.`);
    else if (/:\/\/|@|^\.|^\//.test(line)) errors.push(`requirements.txt line ${i + 1}: URL/path/VCS requirements are not allowed.`);
    else if (!pkg.test(line)) errors.push(`requirements.txt line ${i + 1}: invalid requirement "${line.slice(0, 60)}".`);
  });
  return errors;
}

function parseJson(src: string | undefined, name: string): any {
  if (src === undefined) return undefined;
  try { return JSON.parse(src); } catch { throw new DetectionError("invalid_manifest", `${name} is not valid JSON.`); }
}

function pickEntry(files: Map<string, Buffer>, candidates: string[], declared?: string): string | undefined {
  if (declared && ENTRY_RE.test(declared) && files.has(declared.replace(/^\.\//, ""))) return declared.replace(/^\.\//, "");
  return candidates.find((c) => files.has(c));
}

export function detectProject(files: Map<string, Buffer>, override?: { entryPoint?: string; language?: Language }): Manifest {
  const has = (p: string) => files.has(p);
  const anyExt = (ext: string) => [...files.keys()].some((k) => k.endsWith(ext));
  const scores: Record<Language, number> = { python: 0, node: 0, php: 0 };
  if (has("requirements.txt")) scores.python += 3;
  if (has("pyproject.toml")) scores.python += 3;
  if (anyExt(".py")) scores.python += 1;
  if (has("package.json")) scores.node += 4;
  if (has("package-lock.json")) scores.node += 1;
  if (anyExt(".js") || anyExt(".mjs")) scores.node += 1;
  if (has("composer.json")) scores.php += 4;
  if (anyExt(".php")) scores.php += 1;
  const manifestLangs = ([
    ["python", has("requirements.txt") || has("pyproject.toml")],
    ["node", has("package.json")],
    ["php", has("composer.json")],
  ] as [Language, boolean][]).filter(([, v]) => v).map(([k]) => k);
  if (manifestLangs.length > 1 && !override?.language)
    throw new DetectionError("ambiguous", `Project contains dependency manifests for ${manifestLangs.join(" and ")}; remove the unrelated ones or choose a language.`);
  const ranked = (Object.entries(scores) as [Language, number][]).sort((a, b) => b[1] - a[1]);
  if (ranked[0][1] === 0) throw new DetectionError("unsupported", "Could not detect Python, Node.js or PHP in this project.");
  if (!override?.language && ranked[0][1] === ranked[1][1]) throw new DetectionError("ambiguous", `Project looks like both ${ranked[0][0]} and ${ranked[1][0]}; remove unrelated manifests.`);
  const language = override?.language ?? ranked[0][0];
  const warnings: string[] = [];
  let entry: string | undefined;
  const dependencyFiles: string[] = [];
  const install: string[] = []; const build: string[] = [];
  let start = ""; let tools: string[] = [];

  if (override?.entryPoint) {
    if (!ENTRY_RE.test(override.entryPoint) || !has(override.entryPoint)) throw new DetectionError("bad_entry", "Entry point does not exist in the project.");
  }

  if (language === "python") {
    tools = ["python3", "pip"];
    entry = override?.entryPoint ?? pickEntry(files, PY_ENTRIES);
    if (has("requirements.txt")) {
      dependencyFiles.push("requirements.txt");
      const errs = validateRequirements(text(files, "requirements.txt")!);
      if (errs.length) throw new DetectionError("invalid_manifest", errs.slice(0, 5).join(" "));
      install.push("python3 -m venv .venv", ".venv/bin/pip install --no-input --disable-pip-version-check -r requirements.txt");
    } else if (has("pyproject.toml")) {
      dependencyFiles.push("pyproject.toml");
      install.push("python3 -m venv .venv", ".venv/bin/pip install --no-input --disable-pip-version-check .");
    } else {
      install.push("python3 -m venv .venv");
      warnings.push("No requirements.txt or pyproject.toml: no dependencies will be installed.");
    }
    if (!entry) throw new DetectionError("no_entry", "No entry point found (expected main.py or bot.py).");
    start = `.venv/bin/python -u ${entry}`;
  } else if (language === "node") {
    tools = ["node", "npm"];
    const pkgJson = parseJson(text(files, "package.json"), "package.json");
    if (pkgJson === undefined) throw new DetectionError("invalid_manifest", "package.json is required for Node.js projects.");
    if (typeof pkgJson !== "object" || pkgJson === null || Array.isArray(pkgJson)) throw new DetectionError("invalid_manifest", "package.json must be an object.");
    dependencyFiles.push("package.json");
    if (has("package-lock.json")) {
      parseJson(text(files, "package-lock.json"), "package-lock.json");
      dependencyFiles.push("package-lock.json");
      install.push("npm ci --no-audit --no-fund");
    } else {
      install.push("npm install --no-audit --no-fund");
    }
    if (pkgJson.scripts && typeof pkgJson.scripts.build === "string") build.push("npm run build");
    const declared = typeof pkgJson.main === "string" ? pkgJson.main : undefined;
    entry = override?.entryPoint ?? pickEntry(files, NODE_ENTRIES, declared);
    if (pkgJson.scripts && typeof pkgJson.scripts.start === "string") { start = "npm start --silent"; entry = entry ?? "package.json"; }
    else if (entry) start = `node ${entry}`;
    else throw new DetectionError("no_entry", "No start script or entry point found (expected index.js or bot.js).");
    if (pkgJson.scripts && ["preinstall", "postinstall", "install"].some((k) => typeof pkgJson.scripts[k] === "string"))
      warnings.push("package.json defines install-time scripts; they will run inside the sandbox.");
  } else {
    tools = ["php"];
    entry = override?.entryPoint ?? pickEntry(files, PHP_ENTRIES);
    if (has("composer.json")) {
      const c = parseJson(text(files, "composer.json"), "composer.json");
      if (typeof c !== "object" || c === null || Array.isArray(c)) throw new DetectionError("invalid_manifest", "composer.json must be an object.");
      dependencyFiles.push("composer.json");
      if (has("composer.lock")) dependencyFiles.push("composer.lock");
      tools.push("composer");
      install.push("composer install --no-interaction --no-progress --prefer-dist --no-dev");
    }
    if (!entry) throw new DetectionError("no_entry", "No entry point found (expected index.php or bot.php).");
    start = `php ${entry}`;
  }
  if (!entry || (entry !== "package.json" && !ENTRY_RE.test(entry))) throw new DetectionError("bad_entry", "Unsafe entry point name.");
  return { language, entryPoint: entry, dependencyFiles, installCommands: install, buildCommands: build, startCommand: start, requiredTools: tools, warnings };
}
