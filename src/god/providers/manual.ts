import type { AiProvider, AiRequest, AiResponse } from './ai-provider';

/**
 * Dev-only: a human plays the god. Proposals are canned; implement/repair open a panel
 * where module source is pasted (exercises validation and activation directly).
 */
export class ManualProvider implements AiProvider {
  readonly name = 'manual';
  constructor(private ask: (req: AiRequest) => Promise<string>) {}

  async complete(req: AiRequest): Promise<AiResponse> {
    if (req.role === 'propose') {
      const omen = (title: string, tone: string) => ({
        title, omen: 'A hand from beyond the sky reaches for the island.', change: 'Whatever module source the petitioner pastes.',
        visible: 'Depends on the pasted module.', builds_on: [], tone, suspends: [],
      });
      return { data: { omens: [omen('A manual work', 'cozy'), omen('Another manual work', 'eerie'), omen('A third manual work', 'wild')] }, usage: { input: 0, output: 0 } };
    }
    const source = await this.ask(req);
    return { data: { source, notes: 'pasted by hand' }, usage: { input: 0, output: 0 } };
  }
}
