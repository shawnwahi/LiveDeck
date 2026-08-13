import * as vscode from 'vscode';
import { DeckEditorProvider } from './deckEditorProvider';

function targetUri(uri?: vscode.Uri): vscode.Uri | undefined {
  if (uri) return uri;
  if (vscode.window.activeTextEditor) {
    return vscode.window.activeTextEditor.document.uri;
  }
  const input: any = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input?.uri instanceof vscode.Uri ? input.uri : undefined;
}

export function activate(ctx: vscode.ExtensionContext) {
  ctx.subscriptions.push(DeckEditorProvider.register(ctx));

  ctx.subscriptions.push(
    vscode.commands.registerCommand('livedeck.open', async (uri?: vscode.Uri) => {
      const target = targetUri(uri);
      if (!target) {
        void vscode.window.showErrorMessage('LiveDeck: open an HTML file first.');
        return;
      }
      await vscode.commands.executeCommand(
        'vscode.openWith',
        target,
        DeckEditorProvider.viewType
      );
    }),
    vscode.commands.registerCommand('livedeck.openSource', async (uri?: vscode.Uri) => {
      const target = targetUri(uri);
      if (!target) return;
      await vscode.commands.executeCommand('vscode.openWith', target, 'default');
    })
  );
}

export function deactivate() {}
