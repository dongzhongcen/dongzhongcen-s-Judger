# dzc Writer（dongzhongcen's Judger）

<p align="center">
  <img alt="TypeScript" src="https://img.shields.io/badge/typescript-5.x-blue">
  <img alt="VS Code" src="https://img.shields.io/badge/vscode-1.90%2B-007acc">
  <img alt="Version" src="https://img.shields.io/badge/version-0.3.9-lightgrey">
  <img alt="OpenAI Compatible" src="https://img.shields.io/badge/api-OpenAI--compatible-412991">
  <img alt="Languages" src="https://img.shields.io/badge/judge-C%2B%2B%20%7C%20Java%20%7C%20Python-brightgreen">
</p>

dzc Writer 是一个 VS Code 扩展，把 AI 代码生成和本地算法题测试结合在一起。项目目前实现了：识别当前文件开头的题目注释，把题目和当前文件发送到 OpenAI-compatible 接口生成代码并追加到编辑器；以及类似 CPH 的本地测试用例面板，可在本地编译运行 C++、Java、Python 文件并比对输出。

## 功能特性

- **题目注释识别**：识别当前文件开头的文档注释或连续行注释（Python `"""`、C++ `/* */`、Java `/** */`、`#` 行注释等）。
- **AI 代码生成**：将识别到的题目和当前文件内容（默认最多 20000 字符）发送到 OpenAI-compatible 接口（`/responses`）生成代码。
- **预览与应用**：可预览生成结果并追加到当前编辑器，支持应用前确认。
- **追加模式**：`instant` 一次性追加，或 `typewriter` 逐字符模拟输入（含停顿，单次停顿不超过 10 秒）。
- **目标模式**：开启后监听当前文件变化，可配合 `dzcWriter.autoGenerate` 在题目注释变化后自动生成。
- **本地测试用例**：侧边栏 webview 面板，支持输入、期望输出、实际输出和通过/失败比对。
- **本地运行**：支持 C++、Java、Python，编译命令和运行超时可配置。
- **界面语言**：侧边栏支持中英文切换。

## 项目结构

```text
.
├── src/
│   └── extension.ts   # 扩展入口：命令、题目识别、AI 调用、测试面板、本地运行
├── media/icon.svg     # 活动栏图标
├── package.json       # 扩展清单：命令、快捷键、视图、配置项
└── tsconfig.json      # TypeScript 编译到 dist/
```

## 快速开始

### 环境要求

- VS Code 1.90 或更高版本
- Node.js 与 npm（构建扩展时需要）
- 本地评测所需的编译器/解释器：`g++`（C++）、`javac` / `java`（Java）、`python`（Python）

### 构建与打包

```bash
git clone https://github.com/dongzhongcen/dongzhongcen-s-Judger.git
cd dongzhongcen-s-Judger
npm install
npm run compile
npm run package
```

打包后会生成 `dzc-writer-0.3.9.vsix`。开发时可以使用 `npm run watch` 持续编译。

### 安装扩展

```bash
code --install-extension dzc-writer-0.3.9.vsix
```

也可以在 VS Code 中通过「扩展 → ... → 从 VSIX 安装」（Install from VSIX...）安装，然后执行 `Ctrl + Shift + P -> Developer: Reload Window` 重新加载窗口。

### 配置 API Key

在环境变量中设置 `OPENAI_API_KEY`，或在 VS Code 用户设置（`Preferences: Open User Settings (JSON)`）中配置：

```json
{
  "dzcWriter.apiKey": "YOUR_OPENAI_API_KEY",
  "dzcWriter.model": "gpt-4.1",
  "dzcWriter.apiBaseUrl": "https://api.openai.com/v1",
  "dzcWriter.confirmBeforeApply": false,
  "dzcWriter.appendMode": "instant",
  "dzcWriter.typewriterCharsPerTick": 1,
  "dzcWriter.showNotifications": false,
  "dzcWriter.uiLanguage": "en"
}
```

Windows 下也可以用环境变量（设置后需重启 VS Code）：

```powershell
setx OPENAI_API_KEY "YOUR_OPENAI_API_KEY"
```

使用兼容的代理或中转服务时，只需修改 `dzcWriter.apiBaseUrl`。

### 命令

- `dzc Writer: Toggle Goal Mode`
- `dzc Writer: Generate For Active File`（`Ctrl+Alt+G`，macOS：`Cmd+Alt+G`）
- `dzc Writer: Apply Last Result`
- `dzc Writer: Show Detected Problem Comment`

### 配置项

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `dzcWriter.model` | `gpt-4.1` | 生成代码使用的模型 |
| `dzcWriter.apiKey` | 空 | API Key，优先使用 `OPENAI_API_KEY` 环境变量 |
| `dzcWriter.apiBaseUrl` | `https://api.openai.com/v1` | OpenAI-compatible 接口地址 |
| `dzcWriter.autoGenerate` | `false` | 目标模式下题目注释变化后自动生成 |
| `dzcWriter.confirmBeforeApply` | `false` | 追加生成内容前是否确认 |
| `dzcWriter.appendMode` | `instant` | `instant` 或 `typewriter` |
| `dzcWriter.typewriterCharsPerTick` | `1` | typewriter 模式每次插入的字符数 |
| `dzcWriter.showNotifications` | `false` | 是否显示非错误类通知 |
| `dzcWriter.debounceMs` | `1200` | 目标模式下响应文档变化的延迟 |
| `dzcWriter.maxInputChars` | `20000` | 发送给模型的最大字符数 |
| `dzcWriter.uiLanguage` | `en` | 侧边栏语言，`en` 或 `zh` |
| `dzcWriter.runTimeoutMs` | `5000` | 本地测试运行超时 |
| `dzcWriter.cppCompileCommand` | `g++ -std=c++17 -O2 "${file}" -o "${exe}"` | C++ 编译命令 |
| `dzcWriter.javaCompileCommand` | `javac "${file}"` | Java 编译命令 |

Python 文件直接以 `python file.py` 运行。

## 当前状态

项目已完成题目识别、AI 生成、追加模式和本地测试面板等核心功能，当前版本 0.3.9。后续可继续完善：

- 修正 `package.json` 中 `displayName` 的拼写（`Jugder` → `Judger`）
- 将 `activationEvents` 中的 `*` 改为按需激活，减少启动开销
- 支持配置 Python 解释器命令（目前固定为 `python`）
- 在 GitHub Releases 提供打包好的 `.vsix`
- 增加单元测试

## 数据和敏感信息

不要把 API Key 提交到仓库。`node_modules/`、`dist/`、`*.vsix` 打包产物和日志已通过 `.gitignore` 排除。
