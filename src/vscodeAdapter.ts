/**
 * HostAdapter for the VS Code / Cursor custom editor: the deck is a normal
 * TextDocument, edits are WorkspaceEdits, undo/redo/save are the editor's.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_CONFIG, HostAdapter, TextChange } from './deckSession';

export const API_KEY_SECRET = 'livedeck.anthropicApiKey';

export class VscodeAdapter implements HostAdapter {
  constructor(
    private readonly document: vscode.TextDocument,
    private readonly panel: vscode.WebviewPanel,
    private readonly ctx: vscode.ExtensionContext
  ) {}

  get fsPath(): string | null {
    return this.document.uri.scheme === 'file' ? this.document.uri.fsPath : null;
  }

  getText() {
    return this.document.getText();
  }

  isDirty() {
    return this.document.isDirty;
  }

  private range(start: number, end: number) {
    return new vscode.Range(this.document.positionAt(start), this.document.positionAt(end));
  }

  replace(start: number, end: number, text: string): Promise<boolean> {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(this.document.uri, this.range(start, end), text);
    return Promise.resolve(vscode.workspace.applyEdit(edit));
  }

  onDidChange(cb: (changes: TextChange[]) => void) {
    return vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== this.document.uri.toString()) return;
      cb(e.contentChanges.map((c) => ({ start: c.rangeOffset, end: c.rangeOffset + c.rangeLength })));
    });
  }

  onDidSave(cb: () => void) {
    return vscode.workspace.onDidSaveTextDocument((d) => {
      if (d.uri.toString() === this.document.uri.toString()) cb();
    });
  }

  post(msg: unknown) {
    void this.panel.webview.postMessage(msg);
  }

  baseHref(): string {
    if (this.document.uri.scheme !== 'file') return '';
    const dir = vscode.Uri.file(path.dirname(this.document.uri.fsPath));
    return this.panel.webview.asWebviewUri(dir).toString() + '/';
  }

  config() {
    const c = vscode.workspace.getConfiguration('livedeck', this.document.uri);
    return {
      slideSelectors: c.get<string[]>('slideSelectors') ?? DEFAULT_CONFIG.slideSelectors,
      editDebounceMs: c.get<number>('editDebounceMs') ?? DEFAULT_CONFIG.editDebounceMs,
      pastePlainText: c.get<boolean>('pastePlainText') ?? DEFAULT_CONFIG.pastePlainText,
      normalizeMarkup: c.get<boolean>('normalizeMarkup') ?? DEFAULT_CONFIG.normalizeMarkup,
      imageFolder: c.get<string>('imageFolder') ?? DEFAULT_CONFIG.imageFolder,
    };
  }

  async undo() {
    await vscode.commands.executeCommand('undo');
  }

  async redo() {
    await vscode.commands.executeCommand('redo');
  }

  async save() {
    await vscode.commands.executeCommand('workbench.action.files.save');
  }

  async openSource() {
    await vscode.commands.executeCommand('vscode.openWith', this.document.uri, 'default', vscode.ViewColumn.Beside);
  }

  async openBrowser() {
    if (this.document.uri.scheme === 'file') await vscode.env.openExternal(this.document.uri);
  }

  async reveal(start: number, end: number) {
    await vscode.window.showTextDocument(this.document, {
      viewColumn: vscode.ViewColumn.Beside,
      selection: this.range(start, end),
    });
  }

  async openExternal(url: string) {
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  async clipboardRead() {
    return vscode.env.clipboard.readText();
  }

  async clipboardWrite(text: string) {
    await vscode.env.clipboard.writeText(text);
  }

  async pickImageFile(defaultDir: string, exts: string[]) {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      defaultUri: vscode.Uri.file(defaultDir),
      filters: { Images: exts },
      openLabel: 'Insert image',
    });
    return picked?.[0]?.scheme === 'file' ? picked[0].fsPath : null;
  }

  async anthropicClient(): Promise<Anthropic | { error: string }> {
    let key = await this.ctx.secrets.get(API_KEY_SECRET);
    if (!key && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      key = await vscode.window.showInputBox({
        title: 'LiveDeck: Anthropic API key',
        prompt: 'Needed for "AI this element". Stored in VS Code secret storage.',
        password: true,
        ignoreFocusOut: true,
      });
      if (!key) return { error: 'No API key — cancelled' };
      await this.ctx.secrets.store(API_KEY_SECRET, key.trim());
    }
    return key ? new Anthropic({ apiKey: key.trim() }) : new Anthropic();
  }

  async onAuthError() {
    await this.ctx.secrets.delete(API_KEY_SECRET);
    return 'Invalid API key — run the command again to enter a new one';
  }
}
