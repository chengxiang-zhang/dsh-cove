# @dsh-cove/dsh-client-ui-community-plugins

English | [中文](README.zh.md)

The community plugin index data source: `community.json` is the single source of the community plugin catalog. Entries carry links and metadata for third-party plugins in their authors' own repositories; this repository does not vendor their code.

## What it does

- Index data: `community.json` is merged by maintainer review; every entry requires `id` / `name` / `nameEn` / `author` / `repo` plus optional `description` / `descriptionEn` / `npm` / `category` / `subcategory` (`subcategory` is the second-level classification under `category`, accepted only when `category` is set; the enums live in `scripts/community-index`).
- Validation: `node scripts/community-index` checks the index contract (the `pnpm community:check` CI gate runs the same check).
- Runtime shape: this is a data package and contributes no runtime entity or settings surface.

## Install

Do not mount this package in a DSH profile. Consumers read its exported `community.json` data.

## Config

The package has no runtime configuration. Catalog entries are maintained directly in `community.json`.

## Known limitations

- The index only carries links; it does not validate third-party code quality or security, and each entry belongs to its original author.
- Entry changes reach consumers when the package is published; this repository generates no catalog page and runs no deployment for it.
