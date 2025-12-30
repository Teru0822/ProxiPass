# AI Agent Guide for P2P File Share (v2)

このリポジトリで作業を行うAIエージェント向けのガイドラインです。
以下のルールに従うことで、ユーザーとのコラボレーションや継続的な開発をスムーズに進めることができます。

## 1. バージョン管理とリリース (Version Control & Release)

- **バージョン更新**:
  - コードに変更を加えた場合は、必ず `package.json` の `version` をインクリメント (例: 0.0.1 -> 0.0.2) してください。
  - バージョン番号は自動更新システム（GitHub連携）のトリガーとなります。
- **Git コミットとプッシュ**:
  - 変更後は直ちに `git add .`, `git commit -m "vX.X.X: <変更内容>"`, `git push` を行ってください。
  - これにより、GitHubのリポジトリが更新され、アプリ側の自動アップデート通知機能が動作します。
  - **重要**: タグを手動で打つ必要はありません。`package.json` の変更を検知して運用します。

## 2. 自動更新システム (Auto-Update System)

- **仕組み**:
  - アプリ（`main.js`）は、GitHub上の `package.json` を定期的に監視しています。
  - ローカルバージョンより新しいバージョンを検知すると、ユーザーに通知を出します。
  - 全ファイルをダウンロードして上書き更新するシンプルな仕組みです。
- **注意点**:
  - `main.js` や `renderer.js` のロジックを変更する際は、自動更新の流れを壊さないように注意してください。

## 3. Workflow Rules (Automatic Actions)

1. **Auto-Push instead of Auto-Start**:
    - When code changes are made (e.g., using `replace_file_content`), do **NOT** run `npm start`.
    - Instead, automatically commit the changes and **push to GitHub**.
    - Always increment the patch version in `package.json` before pushing.
    - Commit message format: `v[VERSION]: [Description of changes]`.
