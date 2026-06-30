#!/usr/bin/env node

/**
 * Document Evidence Inventory v0.2 - Stage 1
 *
 * Read-only metadata listing for Google Drive folders.
 *
 * This script intentionally does NOT:
 * - download file contents;
 * - export Google Docs;
 * - run OCR;
 * - modify Google Drive;
 * - modify existing site files;
 * - select canonical documents.
 *
 * Required Google Drive scope:
 * https://www.googleapis.com/auth/drive.metadata.readonly
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const SCHEMA_VERSION = "document-evidence-inventory-v0.2-stage1";
const MODE = "read_only_metadata_only";
const READ_ONLY_SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";

const DEFAULT_CONFIG = "data/inventory/folders.json";
const DEFAULT_OUT = "data/inventory/raw-drive-inventory.json";
const DEFAULT_REPORT = "data/inventory/inventory-report.md";

const LIST_FIELDS = [
  "nextPageToken",
  "files(id,name,mimeType,parents,webViewLink,createdTime,modifiedTime,size,md5Checksum,shortcutDetails(targetId,targetMimeType,targetResourceKey))"
].join(", ");

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
Document Evidence Inventory v0.2 - Stage 1

Usage:
  node scripts/inventory-drive-stage1.mjs [options]

Options:
  --config <path>   Folder config JSON. Default: ${DEFAULT_CONFIG}
  --out <path>      Raw inventory JSON output. Default: ${DEFAULT_OUT}
  --report <path>   Markdown report output. Default: ${DEFAULT_REPORT}
  --dry-run         Validate config and print planned roots. No Google API calls.
  --no-write        List metadata but do not write output files.
  --help            Show this help.

Read-only scope:
  ${READ_ONLY_SCOPE}
`;
}

function isPlaceholder(value) {
  return !value || value.startsWith("PASTE_");
}

async function loadConfig(configPath) {
  const text = await readFile(configPath, "utf8");
  const config = JSON.parse(text);

  if (config.schema_version !== "document-evidence-inventory-v0.2-folders") {
    throw new Error(`Unexpected config schema_version: ${config.schema_version}`);
  }

  if (!Array.isArray(config.roots)) {
    throw new Error("Config must contain a roots array.");
  }

  const errors = [];
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

    if (isPlaceholder(root.folder_id)) {
      if (root.required) {
        errors.push(`Required root ${root.label} has no folder_id.`);
      } else {
        skippedRoots.push({ ...root, reason: "empty_or_placeholder" });
      }
      continue;
    }

    activeRoots.push(root);
  }

  return { config, activeRoots, skippedRoots, errors };
}

function mapFileType(mimeType) {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "application/vnd.google-apps.document") return "google_doc";
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimeType === "application/msword"
  ) return "docx";
  if (mimeType === "application/vnd.google-apps.folder") return "folder";
  if (typeof mimeType === "string" && mimeType.startsWith("image/")) return "image";
  return "unknown";
}

function addUnique(array, value) {
  if (!array.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    array.push(value);
  }
}

function mergeFileRecord(existing, next) {
  addUnique(existing.seen_from_roots, next.seen_from_roots[0]);

  if (existing.source_case !== next.source_case) {
    addUnique(existing.review_flags, "seen_from_multiple_cases");
  }

  for (const flag of next.review_flags) {
    addUnique(existing.review_flags, flag);
  }

  return existing;
}

function toInventoryRecord(file, context) {
  const fileType = mapFileType(file.mimeType);
  const reviewFlags = [];

  if (fileType === "unknown") reviewFlags.push("unknown_mime_type");
  if (!file.webViewLink) reviewFlags.push("missing_webViewLink");
  if (!file.md5Checksum) reviewFlags.push("missing_md5Checksum");
  if (file.mimeType === "application/vnd.google-apps.shortcut") reviewFlags.push("shortcut");

  return {
    file_id: file.id || "",
    name: file.name || "",
    mimeType: file.mimeType || "",
    file_type: fileType,
    parent_folder: context.folderId,
    parent_path: context.parentPath,
    webViewLink: file.webViewLink || "",
    createdTime: file.createdTime || "",
    modifiedTime: file.modifiedTime || "",
    size: file.size ? Number(file.size) : null,
    md5Checksum: file.md5Checksum || "",
    source_case: context.case,
    source_folder_label: context.rootLabel,
    seen_from_roots: [
      {
        label: context.rootLabel,
        case: context.case,
        root_folder_id: context.rootFolderId,
        parent_folder: context.folderId,
        parent_path: context.parentPath
      }
    ],
    review_flags: reviewFlags
  };
}

async function createDriveClient() {
  const { google } = await import("googleapis");
  const auth = new google.auth.GoogleAuth({ scopes: [READ_ONLY_SCOPE] });
  return google.drive({ version: "v3", auth });
}

async function listChildren(drive, folderId, errors) {
  const files = [];
  let pageToken;

  do {
    try {
      const response = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: LIST_FIELDS,
        pageSize: 1000,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });

      files.push(...(response.data.files || []));
      pageToken = response.data.nextPageToken;
    } catch (error) {
      errors.push({
        stage: "files.list",
        folder_id: folderId,
        message: error.message
      });
      break;
    }
  } while (pageToken);

  return files;
}

async function scanDriveMetadata(drive, activeRoots) {
  const errors = [];
  const filesById = new Map();
  const folderChildrenCache = new Map();
  const visitedContexts = new Set();

  const queue = activeRoots.map((root) => ({
    folderId: root.folder_id,
    parentPath: root.label,
    rootLabel: root.label,
    rootFolderId: root.folder_id,
    case: root.case
  }));

  while (queue.length > 0) {
    const context = queue.shift();
    const contextKey = `${context.rootLabel}:${context.folderId}`;
    if (visitedContexts.has(contextKey)) continue;
    visitedContexts.add(contextKey);

    if (!folderChildrenCache.has(context.folderId)) {
      const children = await listChildren(drive, context.folderId, errors);
      folderChildrenCache.set(context.folderId, children);
    }

    const children = folderChildrenCache.get(context.folderId);
    for (const file of children) {
      const record = toInventoryRecord(file, context);

      if (filesById.has(record.file_id)) {
        mergeFileRecord(filesById.get(record.file_id), record);
      } else {
        filesById.set(record.file_id, record);
      }

      if (record.file_type === "folder") {
        queue.push({
          folderId: file.id,
          parentPath: `${context.parentPath} / ${file.name}`,
          rootLabel: context.rootLabel,
          rootFolderId: context.rootFolderId,
          case: context.case
        });
      }
    }
  }

  return {
    files: Array.from(filesById.values()).sort((a, b) => {
      return `${a.source_case}:${a.parent_path}:${a.name}`.localeCompare(`${b.source_case}:${b.parent_path}:${b.name}`);
    }),
    errors
  };
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item[key] || "(missing)";
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

function createInventoryPayload({ activeRoots, skippedRoots, files, errors }) {
  const summary = {
    total_items: files.length,
    total_folders: files.filter((file) => file.file_type === "folder").length,
    total_non_folders: files.filter((file) => file.file_type !== "folder").length,
    by_file_type: countBy(files, "file_type"),
    by_source_case: countBy(files, "source_case"),
    missing_webViewLink: files.filter((file) => file.review_flags.includes("missing_webViewLink")).length,
    missing_md5Checksum: files.filter((file) => file.review_flags.includes("missing_md5Checksum")).length,
    shortcuts: files.filter((file) => file.review_flags.includes("shortcut")).length,
    unknown_mime_types: files.filter((file) => file.review_flags.includes("unknown_mime_type")).length,
    errors: errors.length
  };

  return {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    mode: MODE,
    roots: activeRoots.map((root) => ({
      label: root.label,
      case: root.case,
      folder_id: root.folder_id,
      required: Boolean(root.required)
    })),
    skipped_roots: skippedRoots,
    summary,
    files,
    errors
  };
}

function formatCountMap(map) {
  const entries = Object.entries(map);
  if (entries.length === 0) return "- none\n";
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n") + "\n";
}

function createReport(payload) {
  const lines = [];
  lines.push("# Document Evidence Inventory Stage 1 Report");
  lines.push("");
  lines.push(`Schema: ${payload.schema_version}`);
  lines.push(`Generated at: ${payload.generated_at}`);
  lines.push(`Mode: ${payload.mode}`);
  lines.push("");
  lines.push("## Roots Scanned");
  lines.push("");
  for (const root of payload.roots) {
    lines.push(`- ${root.label} (${root.case}): ${root.folder_id}`);
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
  lines.push(`- Folders: ${payload.summary.total_folders}`);
  lines.push(`- Non-folders: ${payload.summary.total_non_folders}`);
  lines.push(`- Missing webViewLink: ${payload.summary.missing_webViewLink}`);
  lines.push(`- Missing md5Checksum: ${payload.summary.missing_md5Checksum}`);
  lines.push(`- Shortcuts: ${payload.summary.shortcuts}`);
  lines.push(`- Unknown mimeTypes: ${payload.summary.unknown_mime_types}`);
  lines.push(`- Listing errors: ${payload.summary.errors}`);
  lines.push("");
  lines.push("## By File Type");
  lines.push("");
  lines.push(formatCountMap(payload.summary.by_file_type).trimEnd());
  lines.push("");
  lines.push("## By Source Case");
  lines.push("");
  lines.push(formatCountMap(payload.summary.by_source_case).trimEnd());
  lines.push("");
  lines.push("## Errors");
  lines.push("");
  if (payload.errors.length === 0) {
    lines.push("- none");
  } else {
    for (const error of payload.errors) {
      lines.push(`- ${error.stage} ${error.folder_id}: ${error.message}`);
    }
  }
  lines.push("");
  lines.push("## Read-Only Guarantee");
  lines.push("");
  lines.push("- Scope: drive.metadata.readonly");
  lines.push("- Uses files.list for metadata listing.");
  lines.push("- Does not download file contents.");
  lines.push("- Does not export Google Docs.");
  lines.push("- Does not run OCR.");
  lines.push("- Does not modify Google Drive or site files.");
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

function printDryRun({ activeRoots, skippedRoots, errors }) {
  console.log("Document Evidence Inventory v0.2 - Stage 1 dry run");
  console.log(`Mode: ${MODE}`);
  console.log("");

  if (activeRoots.length > 0) {
    console.log("Active roots:");
    for (const root of activeRoots) {
      console.log(`- ${root.label} (${root.case}): ${root.folder_id}`);
    }
  } else {
    console.log("Active roots: none");
  }

  if (skippedRoots.length > 0) {
    console.log("");
    console.log("Skipped optional roots:");
    for (const root of skippedRoots) {
      console.log(`- ${root.label} (${root.case}): ${root.reason}`);
    }
  }

  if (errors.length > 0) {
    console.log("");
    console.log("Config errors:");
    for (const error of errors) console.log(`- ${error}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const { activeRoots, skippedRoots, errors: configErrors } = await loadConfig(args.config);

  if (args.dryRun) {
    printDryRun({ activeRoots, skippedRoots, errors: configErrors });
    if (configErrors.length > 0) process.exitCode = 1;
    return;
  }

  if (configErrors.length > 0) {
    throw new Error(`Config is not ready:\n- ${configErrors.join("\n- ")}`);
  }

  const drive = await createDriveClient();
  const scan = await scanDriveMetadata(drive, activeRoots);
  const payload = createInventoryPayload({
    activeRoots,
    skippedRoots,
    files: scan.files,
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
