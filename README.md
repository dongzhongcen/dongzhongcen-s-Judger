# dzc Writer

AI answer generation plus a local competitive programming test runner for VS Code.

## Features

- Detects a leading document comment in the active file.
- Sends the detected task and current file to an OpenAI-compatible API.
- Previews and applies generated code.
- Provides CPH-style local testcases.
- Supports input, expected output, actual output, and pass/fail comparison.
- Runs C++, Java, and Python files locally.
- Supports English and Chinese UI switching.

## Leading Comment Examples

Python:

```python
"""
Write a function that returns the sum of two integers.
"""
```

C++:

```cpp
/*
Solve the problem described here.
Input: ...
Output: ...
*/
```

Java:

```java
/**
 * Solve the problem described here.
 */
```

Line comments are also supported:

```python
# Implement KMP string matching.
# Return the first index where pattern appears in text.
```

## Commands

- `dzc Writer: Toggle Goal Mode`
- `dzc Writer: Generate For Active File`
- `dzc Writer: Apply Last Result`
- `dzc Writer: Show Detected Problem Comment`

## Settings

Set `OPENAI_API_KEY` in your environment, or configure `dzcWriter.apiKey` in VS Code settings.

Important settings:

- `dzcWriter.model`
- `dzcWriter.apiKey`
- `dzcWriter.apiBaseUrl`
- `dzcWriter.autoGenerate`
- `dzcWriter.confirmBeforeApply`
- `dzcWriter.uiLanguage`
- `dzcWriter.runTimeoutMs`
- `dzcWriter.cppCompileCommand`
- `dzcWriter.javaCompileCommand`

## Build VS Code Extension

Users can build this project into a VS Code plugin package (`.vsix`) locally.

Prerequisites:

- VS Code
- Node.js
- npm

Steps:

```bash
git clone https://github.com/dongzhongcen/dongzhongcen-s-Judger.git
cd dongzhongcen-s-Judger
npm install
npm run compile
npm run package
```

After packaging, a file like this will be generated:

```text
dzc-writer-0.3.4.vsix
```

Install it in VS Code:

```bash
code --install-extension dzc-writer-0.3.4.vsix
```

Or install from the VS Code UI:

```text
Extensions -> ... -> Install from VSIX...
```

Then reload VS Code:

```text
Ctrl + Shift + P -> Developer: Reload Window
```

For normal users, the easiest way is to download the `.vsix` file from GitHub Releases if a release is available.

## Local Judge

C++ default compile command:

```bash
g++ -std=c++17 -O2 "${file}" -o "${exe}"
```

Java default compile command:

```bash
javac "${file}"
```

Python files are run directly with:

```bash
python file.py
```

## Publishing Notes

Do not commit `node_modules` or generated `.vsix` files unless you intentionally want to attach a binary release.
