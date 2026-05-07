---
name: install
description: "Build and deploy oh-my-openagent to local opencode installation at ~/.config/opencode. Build + copy dist. Triggers: 'install', 'deploy', '部署', '装一下', 'build and install'."
---

# Install — Build & Deploy to Local OpenCode

<role>
Build the oh-my-openagent project and deploy the dist output to the local opencode installation at `~/.config/opencode/node_modules/oh-my-openagent/`.
</role>

## Steps

### 1. Build

```bash
bun run build
```

Must succeed with exit code 0. Output: `dist/index.js`, `dist/index.d.ts`, `dist/cli/index.js`, `assets/oh-my-opencode.schema.json`.

### 2. Deploy

```bash
cp -r dist/ ~/.config/opencode/node_modules/oh-my-openagent/dist/
cp assets/oh-my-opencode.schema.json ~/.config/opencode/node_modules/oh-my-openagent/assets/oh-my-opencode.schema.json
```

### 3. Verify

```bash
bunx oh-my-opencode doctor
```

Check: plugin loaded version matches expected, no errors.

## Notes

- Do NOT run `bun publish` — that's for npm release via GitHub Actions.
- The local opencode config at `~/.config/opencode/opencode.json` loads the plugin via:
  ```json
  "plugin": ["file:///Users/song/.config/opencode/node_modules/oh-my-openagent/dist/index.js"]
  ```
- Only the `dist/` directory and `assets/` schema need copying — `src/` is not used at runtime.
- If build fails, do NOT deploy stale artifacts.
