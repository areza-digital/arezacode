---
name: change-story
description: Use before committing or creating a pull request in this repository to explain the affected files and their user-visible flow in plain language.
---

# Change Story

Turn the actual change into a short walkthrough a non-technical reader can follow.

1. Before a commit, inspect the staged diff and its file list. Before a pull request, inspect every commit and the full diff against the target branch (`dev` unless specified). Describe only changes included in that operation; do not include unrelated working-tree changes.
2. Write numbered steps in the order a person would experience the change. Use `->` to connect the action to its result. Name the affected file paths in each step, grouping related files when needed so every included file is accounted for. Explain what those files do in everyday language, rather than reciting code or directory names alone.
3. Keep each step to one short sentence. Use a conventional commit title as required by the repository, then put the steps in the commit body and in the final response for a commit. Put the steps in the pull request body and in the final response for a pull request. Keep test results separate and state only checks actually run.

Format:

```text
1. `path/to/file` -> The chat scrollbar stays below the header.
2. `path/to/other-file`, `path/to/test` -> Dragging the scrollbar still reaches the latest message.
```

If there are more than three distinct changes, continue numbering; never omit files just to fit three steps. For internal-only changes, describe the concrete behavior they support without inventing a user-visible effect. Do not disclose secrets or paste sensitive file contents.
