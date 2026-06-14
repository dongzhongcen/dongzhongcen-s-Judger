import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type DetectedPrompt = {
  languageId: string;
  fullText: string;
  promptText: string;
  promptRange: vscode.Range;
  bodyStartLine: number;
};

type TestCase = {
  id: number;
  input: string;
  expected: string;
  actual?: string;
  status?: 'idle' | 'running' | 'passed' | 'failed' | 'error';
  timeMs?: number;
  error?: string;
};

let goalMode = false;
let lastGeneratedText = '';
let lastDetectedPrompt: DetectedPrompt | null = null;
let pendingTimer: NodeJS.Timeout | undefined;
let lastSeenPromptSignature = '';
let outputChannel: vscode.OutputChannel;
let panelProvider: GoalWriterPanelProvider | undefined;
let aiPanelOpen = false;
let testCases: TestCase[] = [
  { id: 1, input: '', expected: '', status: 'idle' }
];

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('dzc Writer');
  outputChannel.appendLine('dzc Writer activated.');
  panelProvider = new GoalWriterPanelProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('dzcWriter.panel', panelProvider),
    vscode.commands.registerCommand('dzcWriter.toggleGoalMode', async () => {
      goalMode = !goalMode;
      await vscode.window.showInformationMessage(
        `dzc Writer goal mode ${goalMode ? 'enabled' : 'disabled'}.`
      );
      outputChannel.appendLine(`Goal mode: ${goalMode ? 'on' : 'off'}`);
      panelProvider?.refresh();
      if (goalMode) {
        scheduleInspectActiveEditor(context);
      }
    }),
    vscode.commands.registerCommand('dzcWriter.generateForActiveFile', async () => {
      await inspectAndMaybeGenerate(context, false);
    }),
    vscode.commands.registerCommand('dzcWriter.applyLastResult', async () => {
      await applyLastResult();
    }),
    vscode.commands.registerCommand('dzcWriter.showDetectedPrompt', async () => {
      const detected = detectPrompt(vscode.window.activeTextEditor?.document);
      if (!detected) {
        vscode.window.showInformationMessage('No leading problem comment detected.');
        return;
      }
      const preview = detected.promptText.length > 1200
        ? `${detected.promptText.slice(0, 1200)}...`
        : detected.promptText;
      const doc = await vscode.workspace.openTextDocument({
        content: preview,
        language: 'markdown'
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => {
      panelProvider?.refresh();
      if (goalMode) {
        scheduleInspectActiveEditor(context);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!goalMode) {
        return;
      }
      const active = vscode.window.activeTextEditor?.document;
      if (!active || event.document.uri.toString() !== active.uri.toString()) {
        return;
      }
      panelProvider?.refresh();
      scheduleInspectActiveEditor(context);
    }),
    outputChannel
  );
}

export function deactivate() {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
  }
}

function scheduleInspectActiveEditor(context: vscode.ExtensionContext) {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
  }

  const delay = vscode.workspace.getConfiguration('dzcWriter').get<number>('debounceMs', 1200);
  pendingTimer = setTimeout(() => {
    void inspectAndMaybeGenerate(context, true);
  }, delay);
}

async function inspectAndMaybeGenerate(context: vscode.ExtensionContext, autoTriggered: boolean) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  const detected = detectPrompt(editor.document);
  if (!detected) {
    lastDetectedPrompt = null;
    lastSeenPromptSignature = '';
    panelProvider?.refresh();
    if (autoTriggered) {
      outputChannel.appendLine('No leading problem comment detected; skipped.');
    }
    return;
  }

  lastDetectedPrompt = detected;
  panelProvider?.refresh();
  const signature = `${editor.document.uri.toString()}::${detected.promptText}`;
  if (autoTriggered && signature === lastSeenPromptSignature) {
    return;
  }
  lastSeenPromptSignature = signature;

  const autoGenerate = vscode.workspace.getConfiguration('dzcWriter').get<boolean>('autoGenerate', false);
  if (!autoTriggered || autoGenerate) {
    await generateAndOptionallyApply(context, editor, detected);
  } else {
    const action = await vscode.window.showInformationMessage(
      'Problem comment detected.',
      'Generate',
      'Show Prompt'
    );
    if (action === 'Generate') {
      await generateAndOptionallyApply(context, editor, detected);
    } else if (action === 'Show Prompt') {
      await showPromptPreview(detected);
    }
  }
}

async function generateForActiveEditor(context: vscode.ExtensionContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('No active editor.');
    return;
  }

  const detected = detectPrompt(editor.document);
  if (!detected) {
    lastDetectedPrompt = null;
    panelProvider?.refresh('No leading document comment detected.');
    vscode.window.showInformationMessage('No leading document comment detected.');
    return;
  }

  lastDetectedPrompt = detected;
  panelProvider?.refresh('Generating answer...');
  try {
    await generateAndOptionallyApply(context, editor, detected);
    panelProvider?.refresh('Generation finished.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(message);
    panelProvider?.refresh('Generation failed.');
    vscode.window.showErrorMessage(message);
  }
}

function detectPrompt(document?: vscode.TextDocument | null): DetectedPrompt | null {
  if (!document || document.isUntitled) {
    return null;
  }

  const lines: string[] = [];
  const maxLines = Math.min(document.lineCount, 80);
  for (let i = 0; i < maxLines; i++) {
    lines.push(document.lineAt(i).text);
  }

  const joined = lines.join('\n');
  const trimmed = joined.trimStart();
  if (!trimmed) {
    return null;
  }

  const blockMatch = matchLeadingBlockComment(lines);
  if (blockMatch) {
    return blockMatch;
  }

  const lineMatch = matchLeadingLineComments(lines);
  if (lineMatch) {
    return lineMatch;
  }

  return null;
}

function matchLeadingBlockComment(lines: string[]): DetectedPrompt | null {
  const text = lines.join('\n');
  const patterns: Array<{ start: RegExp; end: string }> = [
    { start: /^(\s*)\/\*\*?/, end: '*/' },
    { start: /^(\s*)"""/, end: '"""' },
    { start: /^(\s*)'''/, end: "'''" }
  ];

  for (const pattern of patterns) {
    const startMatch = text.match(pattern.start);
    if (!startMatch) {
      continue;
    }
    const startLength = startMatch[0].length;
    const endIndex = text.indexOf(pattern.end, startLength);
    if (endIndex < 0) {
      continue;
    }
    const blockText = text.slice(0, endIndex + pattern.end.length);
    const promptText = extractPromptText(blockText);
    if (!promptText) {
      continue;
    }
    return {
      languageId: 'plaintext',
      fullText: text,
      promptText,
      promptRange: new vscode.Range(0, 0, Math.min(lines.length - 1, 50), lines[Math.min(lines.length - 1, 50)]?.length ?? 0),
      bodyStartLine: Math.min(lines.length, blockText.split('\n').length)
    };
  }
  return null;
}

function matchLeadingLineComments(lines: string[]): DetectedPrompt | null {
  const commentLines: string[] = [];
  let sawComment = false;
  for (const line of lines.slice(0, 20)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (sawComment) {
        break;
      }
      continue;
    }
    if (/^(#|\/\/|--)/.test(trimmed)) {
      sawComment = true;
      commentLines.push(trimmed);
      continue;
    }
    if (sawComment) {
      break;
    }
    return null;
  }

  if (!commentLines.length) {
    return null;
  }

  const promptText = commentLines
    .map((line) => line.replace(/^(#|\/\/|--)\s?/, ''))
    .join('\n')
    .trim();

  if (!promptText) {
    return null;
  }

  return {
    languageId: 'plaintext',
    fullText: lines.join('\n'),
    promptText,
    promptRange: new vscode.Range(0, 0, commentLines.length - 1, lines[commentLines.length - 1]?.length ?? 0),
    bodyStartLine: commentLines.length
  };
}

function extractPromptText(blockText: string): string {
  const stripped = blockText
    .replace(/^(\s*)\/\*\*?/, '')
    .replace(/^(\s*)("""|''')/, '')
    .replace(/\*\/\s*$/, '')
    .replace(/("""|''')\s*$/, '')
    .replace(/^\s*\* ?/gm, '')
    .trim();

  return stripped;
}

async function generateAndOptionallyApply(
  context: vscode.ExtensionContext,
  editor: vscode.TextEditor,
  detected: DetectedPrompt
) {
  const generated = await generateFromPrompt(editor.document, detected.promptText);
  lastGeneratedText = generated;

  const confirmBeforeApply = vscode.workspace.getConfiguration('dzcWriter').get<boolean>('confirmBeforeApply', true);
  const previewDoc = await vscode.workspace.openTextDocument({
    content: generated,
    language: editor.document.languageId || 'plaintext'
  });
  await vscode.window.showTextDocument(previewDoc, { preview: true });

  if (confirmBeforeApply) {
    const choice = await vscode.window.showInformationMessage(
      'Apply generated code to the active editor?',
      'Apply',
      'Cancel'
    );
    if (choice !== 'Apply') {
      return;
    }
  }

  await applyGeneratedTextToEditor(editor, generated, detected);
}

async function generateFromPrompt(document: vscode.TextDocument, promptText: string): Promise<string> {
  const config = vscode.workspace.getConfiguration('dzcWriter');
  const model = config.get<string>('model', 'gpt-4.1');
  const apiBaseUrl = config.get<string>('apiBaseUrl', 'https://api.openai.com/v1').replace(/\/$/, '');
  const apiKey = process.env.OPENAI_API_KEY || config.get<string>('apiKey', '');
  if (!apiKey) {
    throw new Error('Missing OpenAI API key. Set OPENAI_API_KEY or dzcWriter.apiKey.');
  }

  const maxInputChars = config.get<number>('maxInputChars', 20000);
  const source = document.getText().slice(0, maxInputChars);
  const system = [
    'You are a coding assistant inside VS Code.',
    'Read the problem comment at the top of the file.',
    'Write only the code that should replace or fill the file body.',
    'Do not add markdown fences unless the file itself should contain them.',
    'Preserve the user language and naming style when appropriate.',
    'If the comment does not describe a code task, return a short explanation instead of code.'
  ].join(' ');

  const payload = {
    model,
    input: [
      {
        role: 'system',
        content: system
      },
      {
        role: 'user',
        content: `Problem comment:\n${promptText}\n\nCurrent file:\n${source}`
      }
    ]
  };

  const response = await fetch(`${apiBaseUrl}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${response.statusText}\n${text}`);
  }

  const data = await response.json() as any;
  const text = extractResponseText(data);
  if (!text.trim()) {
    throw new Error('Empty model response.');
  }
  return text.trim();
}

function extractResponseText(data: any): string {
  if (typeof data.output_text === 'string') {
    return data.output_text;
  }
  const parts: string[] = [];
  const output = data.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (typeof c?.text === 'string') {
            parts.push(c.text);
          }
          if (typeof c?.content === 'string') {
            parts.push(c.content);
          }
        }
      }
    }
  }
  return parts.join('\n');
}

async function applyGeneratedTextToEditor(
  editor: vscode.TextEditor,
  generated: string,
  detected: DetectedPrompt
) {
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(
    0,
    0,
    editor.document.lineCount,
    0
  );

  const replacement = generated.includes('```')
    ? generated.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '')
    : generated;

  edit.replace(editor.document.uri, fullRange, replacement);
  const success = await vscode.workspace.applyEdit(edit);
  if (!success) {
    throw new Error('Failed to apply generated text.');
  }
  lastGeneratedText = replacement;
  await vscode.window.showInformationMessage('Generated code applied to file.');
  outputChannel.appendLine(`Applied generated text for prompt starting at line ${detected.promptRange.start.line + 1}.`);
}

async function applyLastResult() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('No active editor.');
    return;
  }
  if (!lastGeneratedText.trim()) {
    vscode.window.showInformationMessage('No generated result yet.');
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    'Replace the active editor with the last generated result?',
    'Replace',
    'Cancel'
  );
  if (choice !== 'Replace') {
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(editor.document.uri, new vscode.Range(0, 0, editor.document.lineCount, 0), lastGeneratedText);
  const ok = await vscode.workspace.applyEdit(edit);
  if (ok) {
    vscode.window.showInformationMessage('Last generated result applied.');
  }
}

async function showPromptPreview(detected: DetectedPrompt) {
  const previewDoc = await vscode.workspace.openTextDocument({
    content: detected.promptText,
    language: 'markdown'
  });
  await vscode.window.showTextDocument(previewDoc, { preview: true });
}

function saveTestCase(id: number, input: string, expected: string): void {
  const item = testCases.find((test) => test.id === id);
  if (!item) {
    return;
  }
  item.input = input;
  item.expected = expected;
  item.status = item.status ?? 'idle';
}

function addTestCase(): void {
  const nextId = Math.max(0, ...testCases.map((test) => test.id)) + 1;
  testCases.push({ id: nextId, input: '', expected: '', status: 'idle' });
}

function deleteTestCase(id: number): void {
  testCases = testCases.filter((test) => test.id !== id);
  if (!testCases.length) {
    addTestCase();
  }
}

async function runAllTestCases(): Promise<void> {
  for (const test of [...testCases]) {
    await runOneTestCase(test.id);
  }
}

async function runOneTestCase(id: number): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const test = testCases.find((item) => item.id === id);
  if (!editor || !test) {
    return;
  }

  test.status = 'running';
  panelProvider?.refresh('Running test case...');

  try {
    const result = await runActiveFile(editor.document, test.input);
    test.actual = result.stdout;
    test.timeMs = result.timeMs;
    test.error = result.stderr || result.error;
    const actual = normalizeOutput(result.stdout);
    const expected = normalizeOutput(test.expected);
    if (result.exitCode !== 0) {
      test.status = 'error';
    } else {
      test.status = actual === expected ? 'passed' : 'failed';
    }
  } catch (error) {
    test.status = 'error';
    test.error = error instanceof Error ? error.message : String(error);
  }
}

async function runActiveFile(document: vscode.TextDocument, input: string): Promise<{
  stdout: string;
  stderr: string;
  error?: string;
  exitCode: number | null;
  timeMs: number;
}> {
  if (document.isDirty) {
    await document.save();
  }

  const language = document.languageId;
  const file = document.fileName;
  const ext = path.extname(file).toLowerCase();
  const timeout = vscode.workspace.getConfiguration('dzcWriter').get<number>('runTimeoutMs', 5000);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dzc-writer-'));

  try {
    if (language === 'cpp' || language === 'c' || ['.cpp', '.cc', '.cxx', '.c'].includes(ext)) {
      const exe = path.join(tmpDir, process.platform === 'win32' ? 'main.exe' : 'main');
      const command = vscode.workspace.getConfiguration('dzcWriter')
        .get<string>('cppCompileCommand', 'g++ -std=c++17 -O2 "${file}" -o "${exe}"')
        .replace(/\$\{file\}/g, file)
        .replace(/\$\{exe\}/g, exe);
      const compile = await execShell(command, '', timeout);
      if (compile.exitCode !== 0) {
        return compile;
      }
      return await execFile(exe, [], input, timeout);
    }

    if (language === 'java' || ext === '.java') {
      const command = vscode.workspace.getConfiguration('dzcWriter')
        .get<string>('javaCompileCommand', 'javac "${file}"')
        .replace(/\$\{file\}/g, file);
      const compile = await execShell(command, '', timeout);
      if (compile.exitCode !== 0) {
        return compile;
      }
      const className = path.basename(file, ext);
      return await execFile('java', ['-cp', path.dirname(file), className], input, timeout);
    }

    if (language === 'python' || ext === '.py') {
      return await execFile('python', [file], input, timeout);
    }

    throw new Error(`Unsupported language: ${language || ext}`);
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }, () => undefined);
  }
}

function execShell(command: string, input: string, timeout: number) {
  const start = Date.now();
  return new Promise<{
    stdout: string;
    stderr: string;
    error?: string;
    exitCode: number | null;
    timeMs: number;
  }>((resolve) => {
    const child = cp.exec(command, { timeout }, (error, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        error: error?.message,
        exitCode: typeof (error as any)?.code === 'number' ? (error as any).code : error ? 1 : 0,
        timeMs: Date.now() - start
      });
    });
    if (input) {
      child.stdin?.write(input);
    }
    child.stdin?.end();
  });
}

function execFile(command: string, args: string[], input: string, timeout: number) {
  const start = Date.now();
  return new Promise<{
    stdout: string;
    stderr: string;
    error?: string;
    exitCode: number | null;
    timeMs: number;
  }>((resolve) => {
    const child = cp.spawn(command, args, { shell: false });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        child.kill();
        finished = true;
        resolve({
          stdout,
          stderr,
          error: `Timed out after ${timeout}ms`,
          exitCode: 1,
          timeMs: Date.now() - start
        });
      }
    }, timeout);

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    child.on('error', (error) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, error: error.message, exitCode: 1, timeMs: Date.now() - start });
    });
    child.on('close', (code) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timeMs: Date.now() - start });
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

function normalizeOutput(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

class GoalWriterPanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private status = 'Ready';

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true
    };
    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (message?.type === 'toggleGoalMode') {
        await vscode.commands.executeCommand('dzcWriter.toggleGoalMode');
      }
      if (message?.type === 'setLanguage') {
        await vscode.workspace.getConfiguration('dzcWriter').update('uiLanguage', message.language, vscode.ConfigurationTarget.Global);
      }
      if (message?.type === 'generate') {
        await generateForActiveEditor(this.context);
      }
      if (message?.type === 'toggleAiPanel') {
        aiPanelOpen = !aiPanelOpen;
      }
      if (message?.type === 'showPrompt') {
        const detected = detectPrompt(vscode.window.activeTextEditor?.document);
        if (detected) {
          await showPromptPreview(detected);
        } else {
          vscode.window.showInformationMessage('No leading document comment detected.');
        }
      }
      if (message?.type === 'applyLast') {
        await applyLastResult();
      }
      if (message?.type === 'saveTest') {
        saveTestCase(message.id, message.input ?? '', message.expected ?? '');
      }
      if (message?.type === 'addTest') {
        addTestCase();
      }
      if (message?.type === 'deleteTest') {
        deleteTestCase(message.id);
      }
      if (message?.type === 'runTest') {
        await runOneTestCase(message.id);
      }
      if (message?.type === 'runAll') {
        await runAllTestCases();
      }
      this.refresh();
    });
    this.refresh();
  }

  refresh(status?: string): void {
    if (status) {
      this.status = status;
    }
    if (!this.view) {
      return;
    }
    const editor = vscode.window.activeTextEditor;
    const detected = detectPrompt(editor?.document);
    lastDetectedPrompt = detected;
    const fileName = editor ? editor.document.fileName.split(/[\\/]/).pop() ?? 'untitled' : 'No file';
    const promptLength = detected ? detected.promptText.length : 0;
    const language = vscode.workspace.getConfiguration('dzcWriter').get<'en' | 'zh'>('uiLanguage', 'en');
    const passCount = testCases.filter((test) => test.status === 'passed').length;
    const passText = `${passCount} / ${testCases.length}`;
    this.view.webview.html = this.renderHtml(fileName, promptLength, passText, Boolean(detected), language);
  }

  private renderHtml(
    fileName: string,
    promptLength: number,
    passText: string,
    hasPrompt: boolean,
    language: 'en' | 'zh'
  ): string {
    const nonce = createNonce();
    const disabled = hasPrompt ? '' : 'disabled';
    const t = labels[language];
    const nextLanguage = language === 'en' ? 'zh' : 'en';
    const testsHtml = testCases.map((test, index) => this.renderTestCase(test, index + 1, t)).join('\n');
    const detectedText = hasPrompt ? t.detected : t.notDetected;
    const aiBodyStyle = aiPanelOpen ? '' : 'style="display:none"';
    const aiArrow = aiPanelOpen ? 'v' : '>';
    return `<!DOCTYPE html>
<html lang="${language === 'en' ? 'en' : 'zh-CN'}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>dzc Writer</title>
  <style>
    :root {
      --green: #4f8f28;
      --green-hover: #427b20;
      --blue: #1f83b8;
      --blue-hover: #1972a1;
      --danger: #b51f42;
      --gold: #b7791f;
      --border: var(--vscode-panel-border);
      --surface: var(--vscode-sideBar-background);
      --field: var(--vscode-input-background);
      --text: var(--vscode-foreground);
      --muted: var(--vscode-descriptionForeground);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--text);
      background: var(--surface);
    }
    .wrap {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      padding: 10px 8px;
      gap: 10px;
    }
    .top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 2px 4px 8px;
      border-bottom: 1px solid var(--border);
    }
    .title {
      font-size: 17px;
      font-weight: 700;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .lang {
      border: 0;
      border-radius: 5px;
      padding: 5px 8px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      cursor: pointer;
    }
    .counter {
      flex: 0 0 auto;
      padding: 5px 8px;
      border-radius: 6px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      font-weight: 600;
    }
    .panel {
      border-left: 6px solid var(--vscode-focusBorder);
      border-bottom: 1px solid var(--border);
      padding: 10px 10px 12px;
      background: color-mix(in srgb, var(--surface) 92%, var(--text));
    }
    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 10px;
    }
    .panel-title-left {
      display: flex;
      align-items: center;
      min-width: 0;
      gap: 7px;
    }
    .collapse-btn {
      width: 34px;
      height: 34px;
      border: 1px solid var(--vscode-input-border, var(--border));
      background: var(--field);
      color: var(--text);
      border-radius: 3px;
      font-size: 18px;
      font-weight: 700;
      cursor: pointer;
    }
    .panel-name {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--vscode-textLink-foreground);
      font-size: 16px;
      font-weight: 700;
    }
    .chev { font-size: 18px; color: var(--text); }
    .icon-row { display: flex; gap: 6px; flex: 0 0 auto; }
    .icon-btn {
      width: 38px;
      height: 36px;
      border: 0;
      border-radius: 4px;
      display: grid;
      place-items: center;
      color: white;
      font-size: 18px;
      cursor: pointer;
    }
    .play { background: var(--green); }
    .trash { background: var(--danger); }
    .gold { background: var(--gold); }
    .label-line {
      display: flex;
      justify-content: space-between;
      margin: 9px 0 4px;
      font-size: 14px;
    }
    .copy {
      color: var(--muted);
      font-size: 12px;
    }
    .box {
      width: 100%;
      min-height: 36px;
      border: 1px solid var(--vscode-input-border, var(--border));
      background: var(--field);
      color: var(--text);
      padding: 8px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      overflow: auto;
      max-height: 190px;
    }
    .summary {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: center;
      min-height: 36px;
      border: 1px solid var(--vscode-input-border, var(--border));
      background: var(--field);
      padding: 8px;
    }
    .actions {
      display: grid;
      gap: 8px;
      padding: 6px 8px 0;
    }
    .primary,
    .secondary,
    .ai {
      border: 0;
      border-radius: 4px;
      min-height: 40px;
      padding: 9px 10px;
      color: white;
      font-size: 15px;
      font-weight: 650;
      cursor: pointer;
    }
    .primary { background: var(--green); }
    .primary:hover { background: var(--green-hover); }
    .secondary { background: var(--blue); }
    .secondary:hover { background: var(--blue-hover); }
    .ai {
      background: #2563eb;
      min-height: 44px;
    }
    .ai:hover { background: #1d4ed8; }
    button:disabled {
      opacity: .45;
      cursor: not-allowed;
    }
    .test-actions {
      display: grid;
      grid-template-columns: 1fr auto auto;
      gap: 6px;
      align-items: center;
    }
    .ghost {
      border: 0;
      border-radius: 4px;
      min-height: 34px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      cursor: pointer;
    }
    .test-list {
      display: grid;
      gap: 10px;
    }
    .test-card {
      border-left: 6px solid color-mix(in srgb, var(--vscode-focusBorder) 70%, transparent);
      border-bottom: 1px solid var(--border);
      padding: 10px;
      background: color-mix(in srgb, var(--surface) 94%, var(--text));
    }
    .test-title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      color: var(--vscode-textLink-foreground);
      font-size: 15px;
      font-weight: 700;
      margin-bottom: 8px;
    }
    textarea {
      width: 100%;
      min-height: 42px;
      resize: vertical;
      border: 1px solid var(--vscode-input-border, var(--border));
      background: var(--field);
      color: var(--text);
      padding: 7px;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      line-height: 1.4;
    }
    .result {
      margin-top: 8px;
      padding: 7px;
      border: 1px solid var(--border);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      white-space: pre-wrap;
      max-height: 120px;
      overflow: auto;
    }
    .status-pill {
      padding: 3px 7px;
      border-radius: 999px;
      color: white;
      font-size: 12px;
      background: var(--muted);
    }
    .passed { background: var(--green); }
    .failed, .error { background: var(--danger); }
    .running { background: var(--blue); }
    .trigger {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 2px;
      font-size: 14px;
    }
    .trigger input {
      width: 15px;
      height: 15px;
    }
    .footer {
      margin-top: auto;
      padding: 8px;
      border-top: 1px solid var(--border);
      box-shadow: 0 -8px 18px color-mix(in srgb, var(--surface) 55%, transparent);
      display: grid;
      gap: 8px;
    }
    .credit {
      justify-self: center;
      padding: 5px 10px;
      border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 65%, transparent);
      color: var(--muted);
      font-size: 11px;
      letter-spacing: 0;
    }
    .status {
      color: var(--muted);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div class="title">${escapeHtml(t.local)}: ${escapeHtml(fileName)}</div>
      <button class="lang" data-action="setLanguage" data-language="${nextLanguage}">${language === 'en' ? 'ZH' : 'EN'}</button>
    </div>

    <section class="panel">
      <div class="panel-head">
        <div class="panel-title-left">
          <button class="collapse-btn" data-action="toggleAiPanel">${aiArrow}</button>
          <div class="panel-name"><span>${escapeHtml(t.query)}</span></div>
        </div>
        <button class="icon-btn play" title="${escapeHtml(t.startWatch)}" data-action="toggleGoalMode">&#9654;</button>
      </div>

      <div ${aiBodyStyle}>
        <div class="label-line">
          <span>${escapeHtml(t.detectedContent)}</span>
          <span class="copy">${promptLength} ${escapeHtml(t.chars)}</span>
        </div>
        <div class="summary">
          <span>${escapeHtml(detectedText)}</span>
          <button class="ghost" data-action="showPrompt" ${disabled}>${escapeHtml(t.viewContent)}</button>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div class="panel-name"><span class="chev">v</span><span>${escapeHtml(t.tests)}</span></div>
        <div class="counter">${escapeHtml(passText)} ${escapeHtml(t.passedSuffix)}</div>
      </div>
      <div class="test-list">
        ${testsHtml}
      </div>
      <div class="actions">
        <button class="primary" data-action="addTest">+ ${escapeHtml(t.newTest)}</button>
        <button class="secondary" data-action="runAll">&#9655; ${escapeHtml(t.runAll)}</button>
      </div>
    </section>

    <div class="footer">
      <div class="status">${escapeHtml(this.status)}</div>
      <div class="credit">Created by dongzhongcen</div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    function saveTest(card) {
      const id = Number(card.dataset.id);
      const input = card.querySelector('[data-field="input"]').value;
      const expected = card.querySelector('[data-field="expected"]').value;
      vscode.postMessage({ type: 'saveTest', id, input, expected });
    }
    document.addEventListener('click', (event) => {
      const target = event.target.closest('[data-action]');
      if (!target || target.tagName === 'INPUT') return;
      const card = target.closest('[data-test-card]');
      if (card) saveTest(card);
      const payload = { type: target.dataset.action };
      if (target.dataset.id) payload.id = Number(target.dataset.id);
      if (target.dataset.language) payload.language = target.dataset.language;
      vscode.postMessage(payload);
    });
    document.addEventListener('change', (event) => {
      const target = event.target.closest('[data-action]');
      if (!target) return;
      vscode.postMessage({ type: target.dataset.action });
    });
    document.addEventListener('input', (event) => {
      const card = event.target.closest('[data-test-card]');
      if (!card) return;
      clearTimeout(card._timer);
      card._timer = setTimeout(() => saveTest(card), 300);
    });
  </script>
</body>
</html>`;
  }

  private renderTestCase(test: TestCase, index: number, t: UiLabels): string {
    const status = test.status ?? 'idle';
    const actual = test.actual ? escapeHtml(test.actual) : '';
    const time = typeof test.timeMs === 'number' ? `${test.timeMs}ms` : '';
    const statusHtml = status === 'idle'
      ? ''
      : `<span class="status-pill ${status}">${escapeHtml(t[status])}${time ? ` - ${time}` : ''}</span>`;
    return `<section class="test-card" data-test-card data-id="${test.id}">
      <div class="test-title">
        <span>^ TC ${index}</span>
        <div class="icon-row">
          ${statusHtml}
          <button class="icon-btn play" title="${escapeHtml(t.run)}" data-action="runTest" data-id="${test.id}">&#9654;</button>
          <button class="icon-btn trash" title="${escapeHtml(t.delete)}" data-action="deleteTest" data-id="${test.id}">&#9003;</button>
        </div>
      </div>
      <div class="label-line">
        <span>${escapeHtml(t.input)}</span>
        <span class="copy">${escapeHtml(t.copy)}</span>
      </div>
      <textarea data-field="input">${escapeHtml(test.input)}</textarea>
      <div class="label-line">
        <span>${escapeHtml(t.expected)}</span>
        <span class="copy">${escapeHtml(t.copy)}</span>
      </div>
      <textarea data-field="expected">${escapeHtml(test.expected)}</textarea>
      ${actual ? `<div class="result">${actual}</div>` : ''}
    </section>`;
  }
}

type UiLabels = typeof labels.en;

const labels = {
  en: {
    local: 'Local',
    query: 'Query',
    detectedContent: 'Detected content',
    detected: 'Leading document comment detected.',
    notDetected: 'No leading document comment detected.',
    chars: 'chars',
    viewContent: 'View content',
    generate: 'Generate',
    startWatch: 'Start listening',
    stopWatch: 'Stop listening',
    tests: 'Testcases',
    passed: 'passed',
    passedSuffix: 'passed',
    newTest: 'New testcase',
    runAll: 'Run all',
    run: 'Run',
    delete: 'Delete',
    input: 'Input',
    expected: 'Expected output',
    copy: 'copy',
    idle: 'idle',
    running: 'running',
    failed: 'failed',
    error: 'error'
  },
  zh: {
    local: '\u672c\u5730',
    query: '\u67e5\u8be2',
    detectedContent: '\u68c0\u6d4b\u5185\u5bb9',
    detected: '\u5df2\u68c0\u6d4b\u5230\u6587\u4ef6\u5f00\u5934\u6587\u6863\u6ce8\u91ca\u3002',
    notDetected: '\u672a\u68c0\u6d4b\u5230\u6587\u4ef6\u5f00\u5934\u6587\u6863\u6ce8\u91ca\u3002',
    chars: '\u5b57',
    viewContent: '\u67e5\u770b\u5177\u4f53\u5185\u5bb9',
    generate: '\u751f\u6210',
    startWatch: '\u5f00\u59cb\u76d1\u542c',
    stopWatch: '\u505c\u6b62\u76d1\u542c',
    tests: '\u6d4b\u8bd5\u7528\u4f8b',
    passed: '\u901a\u8fc7',
    passedSuffix: '\u901a\u8fc7',
    newTest: '\u65b0\u5efa\u6d4b\u8bd5\u7528\u4f8b',
    runAll: '\u8fd0\u884c\u5168\u90e8',
    run: '\u8fd0\u884c',
    delete: '\u5220\u9664',
    input: '\u8f93\u5165',
    expected: '\u9884\u671f\u8f93\u51fa',
    copy: '\u590d\u5236',
    idle: '\u672a\u8fd0\u884c',
    running: '\u8fd0\u884c\u4e2d',
    failed: '\u5931\u8d25',
    error: '\u9519\u8bef'
  }
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i++) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}