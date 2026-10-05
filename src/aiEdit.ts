/**
 * "AI this element": ask Claude to rewrite one element of the deck.
 *
 * The model sees the element's exact source, the slide around it (for tone
 * and context) and the user's instruction, and returns replacement HTML for
 * that one element. The caller writes it back through a single verified
 * source range — the rest of the file is never touched.
 */
import Anthropic from '@anthropic-ai/sdk';
import { parseFragment } from 'parse5';

export const AI_MODEL = 'claude-opus-5-5';

const SYSTEM = `You edit one element of an HTML slide deck at a time.

You get the element's exact HTML source, the HTML of the slide it sits on (context only), and an instruction from the deck's author. Apply the instruction to that element only.

Rules:
- Reply with the complete replacement HTML for the element inside a single \`\`\`html fenced block. It replaces the element's source exactly, so return the whole element — start tag included — not a diff or a fragment of it.
- Keep the same tag, classes, ids, attributes and inline structure unless the instruction asks to change them; the deck's CSS depends on them. Match the deck's existing markup style and indentation.
- Keep the deck's voice. Don't add markup, styling or content beyond what the instruction calls for.
- For citations or facts, use web search to find real, verifiable sources; never invent a source, URL, quote or number. If you can't find one, say so instead of returning HTML.
- If the instruction can't sensibly be applied to this element, reply with a one-sentence explanation and no HTML block.`;

export interface AiEditInput {
  instruction: string;
  elementHtml: string;
  slideHtml: string | null;
  deckTitle: string;
}

export type AiEditResult = { html: string } | { message: string };

/** Extract the replacement HTML from the model's reply, or its explanation. */
export function parseReply(text: string): AiEditResult {
  const m = text.match(/```(?:html)?[ \t]*\r?\n([\s\S]*?)\r?\n?```/i);
  if (!m) return { message: text.trim() || 'The model returned nothing.' };
  const html = m[1].trim();
  if (!html) return { message: 'The model returned an empty element.' };
  return { html };
}

/** The replacement must be element markup: at least one element, no stray top-level text. */
export function validateReplacement(html: string): string | null {
  // parse inside <template> so table parts (<tr>, <td>) survive on their own
  const frag: any = parseFragment(`<template>${html}</template>`);
  const tpl = frag.childNodes?.[0];
  const nodes = (tpl?.content?.childNodes ?? []).filter(
    (n: any) => !(n.nodeName === '#text' && !n.value.trim()) && n.nodeName !== '#comment'
  );
  if (!nodes.length) return 'the reply contained no HTML element';
  if (nodes.some((n: any) => n.nodeName === '#text')) return 'the reply contained text outside any element';
  if (/<\/?(html|head|body)[\s>]/i.test(html)) return 'the reply contained a whole document';
  return null;
}

export async function runAiEdit(
  client: Anthropic,
  input: AiEditInput,
  signal: AbortSignal
): Promise<AiEditResult> {
  const context = input.slideHtml
    ? `<slide>\n${input.slideHtml}\n</slide>\n\n`
    : '';
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: 'user',
      content:
        `Deck: ${input.deckTitle || '(untitled)'}\n\n` +
        context +
        `<element>\n${input.elementHtml}\n</element>\n\n` +
        `<instruction>\n${input.instruction}\n</instruction>`,
    },
  ];

  // Server tools (web search) can pause a long turn; resume a few times.
  for (let round = 0; round < 4; round++) {
    const response = await client.beta.messages.create(
      {
        model: AI_MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        system: SYSTEM,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
        messages,
      },
      { signal }
    );
    if (response.stop_reason === 'refusal') {
      return { message: response.stop_details?.explanation || 'The model declined this request.' };
    }
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }
    if (response.stop_reason === 'max_tokens') {
      return { message: 'The reply was cut off (too long). Try a narrower instruction.' };
    }
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return parseReply(text);
  }
  return { message: 'The model did not finish (too many search rounds).' };
}
