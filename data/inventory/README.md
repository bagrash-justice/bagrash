# Document Evidence Inventory v0.2 - Stage 1

This folder contains the preparation files for Stage 1: Google Drive listing
and metadata inventory only.

Stage 1 does not download documents, export Google Docs, run OCR, create HTML,
modify Google Drive, or modify the existing website.

## 1. Fill folder IDs

Edit `data/inventory/folders.json` and replace the placeholder values:

```text
FALL1_FOLDER_ID
FALL2_FOLDER_ID
FALL2_ANLAGEN_FOLDER_ID
FALL3_FOLDER_ID
FALL3_ANLAGEN_FOLDER_ID
FALL4_FOLDER_ID
```

Required roots:

```text
FALL1_FOLDER_ID
FALL2_FOLDER_ID
FALL3_FOLDER_ID
```

Optional roots:

```text
FALL2_ANLAGEN_FOLDER_ID
FALL3_ANLAGEN_FOLDER_ID
FALL4_FOLDER_ID
```

Leave optional placeholders unchanged or empty if they should be skipped.

## 2. Install dependencies

The script uses Node.js and the official Google API client.

Future setup command:

```bash
npm install googleapis
```

No dependency installation has been performed as part of preparing these files.

## 3. Authorize read-only access

The script requires only this Google Drive scope:

```text
https://www.googleapis.com/auth/drive.metadata.readonly
```

One possible future authorization path is Application Default Credentials:

```bash
gcloud auth application-default login --scopes=https://www.googleapis.com/auth/drive.metadata.readonly
```

Alternatively, use a service account and share the relevant Drive folders with
that service account. The service account must have permission to see metadata
for the target folders.

## 4. Validate config without Google Drive access

Future dry-run command:

```bash
node scripts/inventory-drive-stage1.mjs --dry-run
```

Dry-run only reads `data/inventory/folders.json`. It does not call Google Drive.

## 5. Run Stage 1 in the future

Future Stage 1 command:

```bash
node scripts/inventory-drive-stage1.mjs
```

Default outputs after a real run:

```text
data/inventory/raw-drive-inventory.json
data/inventory/inventory-report.md
```

To preview the report without writing files after metadata listing:

```bash
node scripts/inventory-drive-stage1.mjs --no-write
```

`--no-write` still lists Drive metadata, so it requires authorization and Drive
access. It does not download file contents.

## 6. How to verify read-only behavior

The script is designed to use:

```text
files.list
drive.metadata.readonly
```

It does not use:

```text
files.export
files.update
files.delete
files.copy
permissions.create
alt=media downloads
OCR tools
```

The output files contain metadata only: file IDs, names, mime types, parent
folders, links, timestamps, sizes, and checksums when Google Drive exposes them.

## 7. Outputs

`raw-drive-inventory.json` is the machine-readable raw metadata inventory.

`inventory-report.md` is a human-readable summary with counts by case and file
type, missing metadata warnings, and listing errors.

No canonical document selection happens in Stage 1.
