#!/usr/bin/env node

/**
 * Document Evidence Inventory v0.2 - Local Stage 1
 *
 * Local read-only metadata inventory for folders on this Mac.
 *
 * This script intentionally does NOT:
 * - use Google Drive API;
 * - use gcloud;
 * - access the internet;
 * - download documents;
 * - run OCR;
 * - read PDF/DOCX contents;
 * - create HTML/CSS;
 * - modify source folders;
 * - modify existing website files;
 * - select canonical documents.
 *
 * It only reads filesystem metadata. For .gdoc/.gsheet/.gslides files, it may
 * read the small local placeholder JSON to extract URL/document identifiers.
 */

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const SCHEMA_VERSION = "document-evidence-inventory-v0.2-local-stage1";
const CONFIG_SCHEMA_VERSION = "document-evidence-inventory-v0.2-local-folders";
const MODE = "local_read_only_metadata_only";

const DEFAULT_CONFIG = "data/inventory/local-folders.json";
const DEFAULT_OUT = "data/inventory/local-raw-inventory.json";
const DEFAULT_REPORT = "data/inventory/local-inventory-report.md";
const INVENTORY_DIR = path.resolve("data/inventory");

const GOOGLE_PLACEHOLDER_EXTENSIONS = new Set([".gdoc", ".gsheet", ".gslides"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".tif", ".tiff", ".heic", ".webp"]);
const IGNORED_FILENAMES = new Set([".DS_Store"]);

function parseArgs(argv) {
  const args = {
    config: DEFAULT_CONFIG,
    out: DEFAULT_OUT,
    report: DEFAULT_REPORT,
    dryRun: false,
    noWrite: false,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") args.config = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--report") args.report = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--no-write") args.noWrite = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function usage() {
  return `
Document Evidence Inventory v0.2 - Local Stage 1

Usage:
  node scripts/inventory-local-stage1.mjs [options]

Options:
  --config <path>   Local folder config JSON. Default: ${DEFAULT_CONFIG}
  --out <path>      Raw inventory JSON output. Default: ${DEFAULT_OUT}
  --report <path>   Markdown report output. Default: ${DEFAULT_REPORT}
  --dry-run         Validate config and paths. No recursive scan. No writes.
  --no-write        Scan folders and print report. Do not write output files.
  --help            Show this help.

Mode:
  ${MODE}
`;
}

function isPlaceholder(value) {
  return !value || value.startsWith("PASTE_");
}

function ensureOutputPathIsInventoryPath(filePath, label) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(INVENTORY_DIR, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside data/inventory/: ${filePath}`);
  }
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function loadConfig(configPath) {
  const text = await readFile(configPath, "utf8");
  const config = JSON.parse(text);

  if (config.schema_version !== CONFIG_SCHEMA_VERSION) {
    throw new Error(`Unexpected config schema_version: ${config.schema_version}`);
  }

  if (!Array.isArray(config.roots)) {
    throw new Error("Config must contain a roots array.");
  }

  const errors = [];
  const warnings = [];
  const activeRoots = [];
  const skippedRoots = [];
  const seenLabels = new Set();

  for (const root of config.roots) {
    if (!root.label || seenLabels.has(root.label)) {
      errors.push(`Missing or duplicate root label: ${root.label || "(missing)"}`);
      continue;
    }
    seenLabels.add(root.label);

    if (!root.case) {
      errors.push(`Root ${root.label} is missing case.`);
      continue;
    }

    if (isPlaceholder(root.path)) {
      if (root.required) {
        warnings.push(`Required root ${root.label} still has a placeholder path.`);
      } else {
        skippedRoots.push({ ...root, reason: "empty_or_placeholder" });
      }
      continue;
    }

    const resolvedPath = path.resolve(root.path);
    activeRoots.push({
      ...root,
      path: root.path,
      resolved_path: resolvedPath
    });
  }

  return { config, activeRoots, skippedRoots, errors, warnings };
}

async function validateRootPaths(activeRoots, dryRun) {
  const errors = [];
  const warnings = [];

  for (const root of activeRoots) {
    let info;
    try {
      info = await stat(root.resolved_path);
    } catch (error) {
      const message = `${root.label} path is not accessible: ${root.resolved_path} (${error.message})`;
      if (root.required) errors.push(message);
      else warnings.push(message);
      continue;
    }

    if (!info.isDirectory()) {
      const message = `${root.label} path is not a directory: ${root.resolved_path}`;
      if (root.required) errors.push(message);
      else warnings.push(message);
      continue;
    }

    if (dryRun) {
      warnings.push(`${root.label} exists and is a directory: ${root.resolved_path}`);
    }
  }

  return { errors, warnings };
}

function mapFileType(extension, isDirectory) {
  if (isDirectory) return "folder";
  const ext = extension.toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx" || ext === ".doc") return "docx";
  if (GOOGLE_PLACEHOLDER_EXTENSIONS.has(ext)) return "google_doc_placeholder";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "unknown";
}

function extractDocIdFromUrl(url) {
  if (!url || typeof url !== "string") return "";

  const patterns = [
    /\/document\/d\/([^/]+)/,
    /\/spreadsheets\/d\/([^/]+)/,
    /\/presentation\/d\/([^/]+)/,
    /\/file\/d\/([^/]+)/,
    /[?&]id=([^&]+)/
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return decodeURIComponent(match[1]);
  }

  return "";
}

async function readGooglePlaceholder(filePath, reviewFlags) {
  try {
    const text = await readFile(filePath, "utf8");
    const parsed = JSON.parse(text);
    const url = parsed.url || parsed.doc_url || parsed.web_url || "";
    const resourceId = parsed.resource_id || parsed.resourceId || "";
    const docId = parsed.doc_id || parsed.docId || parsed.id || extractDocIdFromUrl(url);

    return {
      google_doc_url: url,
      google_doc_id: docId,
      google_doc_resource_id: resourceId
    };
  } catch {
    reviewFlags.push("gdoc_placeholder_parse_failed");
    return {
      google_doc_url: "",
      google_doc_id: "",
      google_doc_resource_id: ""
    };
  }
}

function detectAnlage(filename) {
  const stem = path.parse(filename).name;
  const caseHintPattern = "(?:Fall|F)[\\s_-]*([123])";
  const patterns = [
    new RegExp(`\\bAnlage[\\s_-]*(\\d{1,4})[\\s_-]*${caseHintPattern}\\b`, "i"),
    new RegExp(`\\b(\\d{1,4})[\\s_-]*${caseHintPattern}\\b`, "i"),
    /^Anlage[\s_-]*(\d{1,4})(?=$|[\s_-]|\s*\()/i
  ];

  for (const pattern of patterns) {
    const match = stem.match(pattern);
    if (match) {
      const number = match[1].padStart(3, "0");
      const caseHint = match[2] ? `fall${match[2]}` : "";
      return {
        number,
        case_hint: caseHint,
        raw_match: match[0]
      };
    }
  }

  return null;
}

function isoOrEmpty(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime()) || date.getTime() <= 0) {
    return "";
  }
  return date.toISOString();
}

function makeRelativePath(rootPath, filePath) {
  const relative = path.relative(rootPath, filePath);
  return relative || ".";
}

function addUnique(array, value) {
  if (!array.includes(value)) array.push(value);
}

async function createItem(root, rootPath, fullPath, fileInfo) {
  const filename = path.basename(fullPath);
  const extension = fileInfo.isDirectory() ? "" : path.extname(filename).toLowerCase();
  const fileType = mapFileType(extension, fileInfo.isDirectory());
  const relativePath = makeRelativePath(rootPath, fullPath);
  const parentPath = path.dirname(relativePath) === "." ? "" : path.dirname(relativePath);
  const reviewFlags = [];
  const possibleAnlageNumber = detectAnlage(filename);

  if (fileType === "unknown") reviewFlags.push("unknown_extension");
  if (fileType === "google_doc_placeholder") reviewFlags.push("google_doc_placeholder");
  if (!isoOrEmpty(fileInfo.birthtime)) reviewFlags.push("missing_created_time");
  if (Number(fileInfo.size) === 0 && !fileInfo.isDirectory()) reviewFlags.push("zero_byte_file");
  if (possibleAnlageNumber) reviewFlags.push("possible_anlage_number_detected");
  if (possibleAnlageNumber?.case_hint && possibleAnlageNumber.case_hint !== root.case) {
    reviewFlags.push("outside_expected_case_hint");
  }

  const item = {
    file_path: fullPath,
    relative_path: relativePath,
    filename,
    extension,
    file_type: fileType,
    size: fileInfo.isDirectory() ? null : Number(fileInfo.size),
    modifiedTime: isoOrEmpty(fileInfo.mtime),
    createdTime: isoOrEmpty(fileInfo.birthtime),
    source_case: root.case,
    source_folder_label: root.label,
    parent_path: parentPath,
    possible_anlage_number: possibleAnlageNumber,
    review_flags: reviewFlags
  };

  if (fileType === "google_doc_placeholder") {
    Object.assign(item, await readGooglePlaceholder(fullPath, reviewFlags));
  }

  return item;
}

async function walkRoot(root, errors) {
  const rootPath = root.resolved_path;
  const items = [];
  const queue = [rootPath];

  while (queue.length > 0) {
    const currentPath = queue.shift();
    let currentStat;

    try {
      currentStat = await stat(currentPath);
    } catch (error) {
      errors.push({
        stage: "stat",
        path: currentPath,
        source_folder_label: root.label,
        message: error.message
      });
      continue;
    }

    try {
      items.push(await createItem(root, rootPath, currentPath, currentStat));
    } catch (error) {
      errors.push({
        stage: "create_item",
        path: currentPath,
        source_folder_label: root.label,
        message: error.message
      });
    }

    if (!currentStat.isDirectory()) continue;

    let children;
    try {
      children = await readdir(currentPath, { withFileTypes: true });
    } catch (error) {
      errors.push({
        stage: "readdir",
        path: currentPath,
        source_folder_label: root.label,
        message: error.message
      });
      const folderItem = items.find((item) => item.file_path === currentPath);
      if (folderItem) addUnique(folderItem.review_flags, "inaccessible_file");
      continue;
    }

    for (const child of children) {
      if (IGNORED_FILENAMES.has(child.name)) continue;
      queue.push(path.join(currentPath, child.name));
    }
  }

  return items;
}

function applyDuplicateNameFlags(items) {
  const groups = new Map();

  for (const item of items) {
    if (item.file_type === "folder") continue;
    const key = item.filename.toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    for (const item of group) addUnique(item.review_flags, "possible_duplicate_name");
  }
}

async function scanLocalMetadata(activeRoots) {
  const errors = [];
  const items = [];

  for (const root of activeRoots) {
    const rootItems = await walkRoot(root, errors);
    items.push(...rootItems);
  }

  applyDuplicateNameFlags(items);

  items.sort((a, b) => {
    return `${a.source_case}:${a.source_folder_label}:${a.relative_path}`.localeCompare(
      `${b.source_case}:${b.source_folder_label}:${b.relative_path}`
    );
  });

  return { items, errors };
}

function countBy(items, getter) {
  return items.reduce((acc, item) => {
    const value = typeof getter === "function" ? getter(item) : item[getter];
    const key = value || "(missing)";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function countReviewFlags(items) {
  const counts = {};
  for (const item of items) {
    for (const flag of item.review_flags || []) {
      counts[flag] = (counts[flag] || 0) + 1;
    }
  }
  return counts;
}

function createInventoryPayload({ activeRoots, skippedRoots, items, errors }) {
  const summary = {
    total_items: items.length,
    total_files: items.filter((item) => item.file_type !== "folder").length,
    total_folders: items.filter((item) => item.file_type === "folder").length,
    by_file_type: countBy(items, "file_type"),
    by_source_case: countBy(items, "source_case"),
    review_flags: countReviewFlags(items),
    errors: errors.length
  };

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    mode: MODE,
    roots: activeRoots.map((root) => ({
      label: root.label,
      case: root.case,
      path: root.path,
      resolved_path: root.resolved_path,
      required: Boolean(root.required)
    })),
    skipped_roots: skippedRoots,
    summary,
    items,
    errors
  };
}

function formatCountMap(map) {
  const entries = Object.entries(map || {});
  if (entries.length === 0) return "- none";
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n");
}

function createReport(payload) {
  const lines = [];
  lines.push("# Document Evidence Inventory Local Stage 1 Report");
  lines.push("");
  lines.push(`Schema: ${payload.schema_version}`);
  lines.push(`Generated at: ${payload.generated_at}`);
  lines.push(`Mode: ${payload.mode}`);
  lines.push("");
  lines.push("## Roots Scanned");
  lines.push("");
  for (const root of payload.roots) {
    lines.push(`- ${root.label} (${root.case}): ${root.resolved_path}`);
  }
  if (payload.roots.length === 0) lines.push("- none");
  lines.push("");
  lines.push("## Skipped Optional Roots");
  lines.push("");
  for (const root of payload.skipped_roots) {
    lines.push(`- ${root.label} (${root.case}): ${root.reason}`);
  }
  if (payload.skipped_roots.length === 0) lines.push("- none");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Total items: ${payload.summary.total_items}`);
  lines.push(`- Files: ${payload.summary.total_files}`);
  lines.push(`- Folders: ${payload.summary.total_folders}`);
  lines.push(`- Errors: ${payload.summary.errors}`);
  lines.push("");
  lines.push("## By File Type");
  lines.push("");
  lines.push(formatCountMap(payload.summary.by_file_type));
  lines.push("");
  lines.push("## By Source Case");
  lines.push("");
  lines.push(formatCountMap(payload.summary.by_source_case));
  lines.push("");
  lines.push("## Review Flags");
  lines.push("");
  lines.push(formatCountMap(payload.summary.review_flags));
  lines.push("");
  lines.push("## Errors");
  lines.push("");
  if (payload.errors.length === 0) {
    lines.push("- none");
  } else {
    for (const error of payload.errors) {
      lines.push(`- ${error.stage} ${error.path}: ${error.message}`);
    }
  }
  lines.push("");
  lines.push("## Read-Only Guarantee");
  lines.push("");
  lines.push("- Uses local filesystem metadata only.");
  lines.push("- Reads .gdoc/.gsheet/.gslides placeholder JSON only.");
  lines.push("- Does not read PDF or DOCX contents.");
  lines.push("- Does not access the internet.");
  lines.push("- Does not use Google Drive API or gcloud.");
  lines.push("- Does not run OCR.");
  lines.push("- Does not modify source folders or website files.");
  lines.push("");

  return lines.join("\n");
}

async function writeJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function writeText(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
}

function printDryRun({ activeRoots, skippedRoots, errors, warnings, pathWarnings }) {
  console.log("Document Evidence Inventory v0.2 - Local Stage 1 dry run");
  console.log(`Mode: ${MODE}`);
  console.log("");

  if (activeRoots.length > 0) {
    console.log("Configured non-placeholder roots:");
    for (const root of activeRoots) {
      console.log(`- ${root.label} (${root.case}): ${root.resolved_path}`);
    }
  } else {
    console.log("Configured non-placeholder roots: none");
  }

  if (skippedRoots.length > 0) {
    console.log("");
    console.log("Skipped optional roots:");
    for (const root of skippedRoots) {
      console.log(`- ${root.label} (${root.case}): ${root.reason}`);
    }
  }

  const allWarnings = [...warnings, ...pathWarnings];
  if (allWarnings.length > 0) {
    console.log("");
    console.log("Warnings:");
    for (const warning of allWarnings) console.log(`- ${warning}`);
  }

  if (errors.length > 0) {
    console.log("");
    console.log("Errors:");
    for (const error of errors) console.log(`- ${error}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  ensureOutputPathIsInventoryPath(args.out, "--out");
  ensureOutputPathIsInventoryPath(args.report, "--report");

  const { activeRoots, skippedRoots, errors: configErrors, warnings } = await loadConfig(args.config);
  const rootValidation = await validateRootPaths(activeRoots, args.dryRun);
  const allErrors = [...configErrors, ...rootValidation.errors];

  if (args.dryRun) {
    printDryRun({
      activeRoots,
      skippedRoots,
      errors: allErrors,
      warnings,
      pathWarnings: rootValidation.warnings
    });
    if (allErrors.length > 0) process.exitCode = 1;
    return;
  }

  if (allErrors.length > 0) {
    throw new Error(`Config is not ready:\n- ${allErrors.join("\n- ")}`);
  }

  const scan = await scanLocalMetadata(activeRoots);
  const payload = createInventoryPayload({
    activeRoots,
    skippedRoots,
    items: scan.items,
    errors: scan.errors
  });
  const report = createReport(payload);

  if (args.noWrite) {
    console.log(report);
    return;
  }

  await writeJson(args.out, payload);
  await writeText(args.report, report);

  console.log(`Wrote ${args.out}`);
  console.log(`Wrote ${args.report}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
