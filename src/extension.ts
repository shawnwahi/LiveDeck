import * as vscode from 'vscode';
import { DeckEditorProvider, API_KEY_SECRET } from './deckEditorProvider';

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
    vscode.commands.registerCommand('livedeck.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        title: 'LiveDeck: Anthropic API key',
        prompt: 'Used by "AI this element". Leave empty to clear the stored key.',
        password: true,
        ignoreFocusOut: true,
      });
      if (key === undefined) return;
      if (key.trim()) await ctx.secrets.store(API_KEY_SECRET, key.trim());
      else await ctx.secrets.delete(API_KEY_SECRET);
      void vscode.window.showInformationMessage(key.trim() ? 'LiveDeck: API key saved.' : 'LiveDeck: API key cleared.');
    }),
    vscode.commands.registerCommand('livedeck.openSource', async (uri?: vscode.Uri) => {
      const target = targetUri(uri);
      if (!target) return;
      await vscode.commands.executeCommand('vscode.openWith', target, 'default');
    })
  );
}

export function deactivate() {}
