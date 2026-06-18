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

### Configure API Key In VS Code

Open VS Code command palette:

```text
Ctrl + Shift + P
```

Run:

```text
Preferences: Open User Settings (JSON)
```

Add your API key:

```json
{
  "dzcWriter.apiKey": "YOUR_OPENAI_API_KEY"
}
```

Full example:

```json
{
  "dzcWriter.apiKey": "YOUR_OPENAI_API_KEY",
  "dzcWriter.model": "gpt-4.1",
  "dzcWriter.confirmBeforeApply": false,
  "dzcWriter.appendMode": "typewriter",
  "dzcWriter.typewriterCharsPerTick": 1,
  "dzcWriter.showNotifications": false,
  "dzcWriter.apiBaseUrl": "https://api.openai.com/v1",
  "dzcWriter.uiLanguage": "en"
}
```

Field meaning:

- `dzcWriter.apiKey`: Your OpenAI API key. Do not share it or commit it to GitHub.
- `dzcWriter.model`: The model used to generate code.
- `dzcWriter.confirmBeforeApply`: Whether to ask before appending generated content.
- `dzcWriter.appendMode`: How generated content is appended. Use `"instant"` for normal one-time append or `"typewriter"` to simulate programmer typing with short thinking pauses.
- `dzcWriter.typewriterCharsPerTick`: Number of characters appended on each typewriter tick. Default is `1` for the most natural effect.
- `dzcWriter.showNotifications`: Whether to show non-error VS Code notification messages. Set it to `false` to keep the extension quiet.
- `dzcWriter.apiBaseUrl`: API base URL. Default is the official OpenAI endpoint.
- `dzcWriter.uiLanguage`: Sidebar language. Use `"en"` or `"zh"`.

### Append Mode

By default, generated content is appended one character at a time with natural programmer-like timing. Normal characters are typed quickly, while line breaks, punctuation, code boundaries, and occasional thinking pauses are slower. A single thinking pause is capped at 10 seconds:

```json
{
  "dzcWriter.appendMode": "typewriter",
  "dzcWriter.typewriterCharsPerTick": 1
}
```

To append generated content all at once:

```json
{
  "dzcWriter.appendMode": "instant"
}
```

If you use a compatible proxy or relay service, change only `apiBaseUrl`:

```json
{
  "dzcWriter.apiBaseUrl": "https://your-api-host.example.com/v1"
}
```

Use the `dzcWriter.*` settings shown above. Older setting names are no longer used.

Then reload VS Code:

```text
Ctrl + Shift + P -> Developer: Reload Window
```

You can also use an environment variable instead:

```powershell
setx OPENAI_API_KEY "YOUR_OPENAI_API_KEY"
```

Restart VS Code after setting the environment variable.

Important settings:

- `dzcWriter.model`
- `dzcWriter.apiKey`
- `dzcWriter.apiBaseUrl`
- `dzcWriter.autoGenerate`
- `dzcWriter.confirmBeforeApply`
- `dzcWriter.appendMode`
- `dzcWriter.typewriterCharsPerTick`
- `dzcWriter.showNotifications`
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
dzc-writer-0.3.9.vsix
```

Install it in VS Code:

```bash
code --install-extension dzc-writer-0.3.9.vsix
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
