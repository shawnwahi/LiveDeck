import * as vscode from 'vscode';
import * as path from 'path';
import { DeckSession } from './deckSession';
import { shellHtml } from './shellHtml';
import { VscodeAdapter } from './vscodeAdapter';

export { API_KEY_SECRET } from './vscodeAdapter';

export class DeckEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'livedeck.editor';

  public static register(ctx: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      DeckEditorProvider.viewType,
      new DeckEditorProvider(ctx),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    );
  }

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const docDir = vscode.Uri.file(path.dirname(document.uri.fsPath));
    const roots = [
      vscode.Uri.joinPath(this.ctx.extensionUri, 'media'),
      ...(vscode.workspace.workspaceFolders?.map((f) => f.uri) ?? []),
    ];
    if (document.uri.scheme === 'file') {
      roots.push(docDir, vscode.Uri.file(path.dirname(docDir.fsPath)));
    }
    const webview = panel.webview;
    webview.options = { enableScripts: true, localResourceRoots: roots };
    webview.html = shellHtml({
      media: (f) => webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', f)).toString(),
      cspSource: webview.cspSource,
    });

    const session = new DeckSession(new VscodeAdapter(document, panel, this.ctx));
    const sub = webview.onDidReceiveMessage((msg) => session.onMessage(msg));
    panel.onDidDispose(() => {
      sub.dispose();
      session.dispose();
    });
  }
}
