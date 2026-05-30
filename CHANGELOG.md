# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `import_plcopenxml` tool: import a PLCopenXML (`.xml`) file into a project (top level) or into a target object/folder. Supports `importFolderStructure` and `conflictResolution` (Replace/Copy/Skip), and reports the number of added objects plus any errors/warnings via an `ImportReporter`.

### Changed
- `compile_project` now reads the CODESYS message store after `build()` and returns structured build results — error and warning counts plus the actual compiler messages — and sets the error flag accordingly, instead of only reporting that compilation was "initiated". Falls back honestly (no false "0 errors") when the message store cannot be read.

### Notes
- Implemented in `src/server.ts` (inline Python script templates + tool handlers). Verified against CODESYS V3.5 SP21 Patch 2 via a standalone MCP client: an injected ST syntax error raised the reported error count, and a PLCopenXML import reported the correct added-object count.

## [1.1.16] - 2025-05-06

### Fixed
- Reverted to v1.1.3 code base which has working POU creation functionality
- Fixed path handling by using simpler approach from v1.1.3
- Restored original Application object finding logic that worked in v1.1.3

## [1.0.0] - 2025-04-23

### Added
- Initial release of the MCP server for CODESYS
- Command-line interface with configuration options
- Project management functionality:
  - Opening existing CODESYS projects
  - Creating new CODESYS projects
  - Saving projects
- POU (Program Organization Unit) management:
  - Creating POUs (Programs, Function Blocks, Functions)
  - Setting POU code (declaration and implementation)
  - Creating properties and methods for Function Blocks
- Project compilation support
- Resources for querying:
  - Project status
  - Project structure
  - POU code
- Documentation for installation and usage
