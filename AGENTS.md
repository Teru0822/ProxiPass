
# Workflow Rules

1. **Auto-Push instead of Auto-Start**:
    - When code changes are made (e.g., using `replace_file_content`), do **NOT** run `npm start`.
    - Instead, automatically commit the changes and **push to GitHub**.
    - Always increment the patch version in `package.json` before pushing.
    - Commit message format: `v[VERSION]: [Description of changes]`.
