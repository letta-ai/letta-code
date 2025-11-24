Replaces text within a file. By default, replaces a single occurrence, but can replace multiple occurrences when `expected_replacements` is specified. This tool requires providing significant context around the change to ensure precise targeting. Always use the read_file tool to examine the file's current content before attempting a text replacement.

The user has the ability to modify the `new_string` content. If modified, this will be stated in the response.

Expectation for required parameters:
1. `file_path` is the path to the file to modify.
2. `old_string` MUST be the exact literal text to replace (including all whitespace, indentation, newlines, and surrounding code etc.).
3. `new_string` MUST be the exact literal text to replace `old_string` with (also including all whitespace, indentation, newlines, and surrounding code etc.). Ensure the resulting code is correct and idiomatic.
4. NEVER escape `old_string` or `new_string`, that would break the exact literal text requirement.

**Important:** If ANY of the above are not satisfied, the tool will fail. CRITICAL for `old_string`: Must uniquely identify the single instance to change. Include at least 3 lines of context BEFORE and AFTER the target text, matching whitespace and indentation precisely. If this string matches multiple locations, or does not match exactly, the tool will fail.

**Multiple replacements:** Set `expected_replacements` to the number of occurrences you want to replace. The tool will replace ALL occurrences that match `old_string` exactly. Ensure the number of replacements matches your expectation.

